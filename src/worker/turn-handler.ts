import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { turn_state } from '../db/schema.js';
import { track } from '../lifecycle.js';
import { PROMPT_VERSION, renderSystemPrompt } from '../llm/prompt.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../logger.js';
import {
  m_critic_attempts,
  m_llm_cost_usd,
  m_llm_tokens,
  m_turn_latency,
  m_turns_total,
} from '../metrics.js';
import { writeEpisodic } from '../memory/episodic.js';
import { syncUserProfile } from '../memory/profile.js';
import { postReply, ProgressiveReply } from '../slack/output.js';
import { markThreadActive } from '../slack/reactions.js';
import type { EnrichedEvent } from '../slack/types.js';
import type { ToolContext } from '../tools/types.js';
import { runInlineCritic } from './inline-critic.js';
import { runToolLoop } from './tool-loop.js';
import { loadTurnContext } from './turn-context.js';
import { persistErroredTurn, persistSuccessfulTurn } from './turn-persistence.js';

const LOCK_RETRY_DELAY_MS = 3000;

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

async function alreadyReplied(eventId: string): Promise<boolean> {
  if (!isMemoryEnabled()) return false;
  const db = getDb();
  const rows = await db
    .select({ status: turn_state.status })
    .from(turn_state)
    .where(eq(turn_state.event_id, eventId))
    .limit(1);
  return rows[0]?.status === 'replied';
}

async function recordReplied(
  eventId: string,
  turnId: string,
  channelId?: string,
  botMsgTs?: string,
): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  await db
    .insert(turn_state)
    .values({
      event_id: eventId,
      turn_id: turnId,
      status: 'replied',
      replied_at: new Date(),
      channel_id: channelId ?? null,
      bot_msg_ts: botMsgTs ?? null,
    })
    .onConflictDoUpdate({
      target: turn_state.event_id,
      set: {
        status: 'replied',
        replied_at: new Date(),
        ...(channelId ? { channel_id: channelId } : {}),
        ...(botMsgTs ? { bot_msg_ts: botMsgTs } : {}),
      },
    });
}

export function makeTurnHandler(redis: Redis) {
  return async function turnJob(
    job: Job<EnrichedEvent>,
    token?: string,
  ): Promise<void> {
    const evt = job.data;

    // (1) Idempotency: skip if already replied (covers BullMQ retries after crash mid-turn)
    if (await alreadyReplied(evt.event_id)) {
      logger.warn({ event_id: evt.event_id }, 'turn already replied — skipping retry');
      return;
    }

    // (2) Per-thread lock: serialize turns inside a thread for coherent UX
    const lockKey = evt.thread_ts ? `thread_lock:${evt.thread_ts}` : null;
    const lockHolder = job.id ?? randomUUID();
    if (lockKey) {
      const acquired = await acquireLock(redis, lockKey, lockHolder);
      if (!acquired) {
        logger.debug(
          { thread_ts: evt.thread_ts, event_id: evt.event_id },
          'thread_lock_busy — delaying',
        );
        await job.moveToDelayed(Date.now() + LOCK_RETRY_DELAY_MS, token);
        throw new DelayedError();
      }
    }

    try {
      await processTurn(redis, evt);
    } finally {
      if (lockKey) await releaseLock(redis, lockKey, lockHolder);
    }
  };
}

async function processTurn(redis: Redis, evt: EnrichedEvent): Promise<void> {
  const turn_id = randomUUID();
  const memoryOn = isMemoryEnabled();

  const userText = stripMention(evt.text);
  const hasFiles = (evt.files ?? []).length > 0;
  if (userText.length === 0 && !hasFiles) {
    logger.debug({ event_id: evt.event_id }, 'empty user text — skipping');
    return;
  }

  const { packed, effectiveThreadTs } = await loadTurnContext(evt, userText);

  const systemContent = renderSystemPrompt({
    user: evt.user_info?.name ?? evt.user_id,
  });

  const ctx: ToolContext = {
    turn_id,
    user_id: evt.user_id,
    channel_id: evt.channel_id,
    channel_type: evt.channel_type,
    thread_ts: effectiveThreadTs,
  };

  // Persist user message synchronously BEFORE LLM call so later turns
  // (and worker retries) see it in their reads.
  if (memoryOn) {
    void track(
      syncUserProfile(evt).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message }, 'syncUserProfile failed'),
      ),
    );
    await writeEpisodic({
      turn_id,
      channel_id: evt.channel_id,
      user_id: evt.user_id,
      thread_ts: effectiveThreadTs,
      role: 'user',
      content: userText,
    });
  }

  const reply = new ProgressiveReply(evt);

  try {
    let result = await runToolLoop({
      redis,
      ctx,
      systemPrompt: systemContent,
      contextBlocks: packed.blocks,
      userText,
      userFiles: evt.files,
      onProgress: (_delta, accumulated) => {
        void reply.update(accumulated);
      },
    });

    // Critic — inline mode (legacy). Default is on_negative-reaction.
    let attempts = 1;
    if (env.CRITIC_ENABLED && env.CRITIC_MODE === 'inline') {
      const outcome = await runInlineCritic({
        redis,
        ctx,
        reply,
        systemPrompt: systemContent,
        contextBlocks: packed.blocks,
        userText,
        result,
        turn_id,
      });
      attempts = outcome.attempts;
      result = outcome.result;
    }
    m_critic_attempts.observe(attempts);

    logger.info(
      {
        turn_id,
        event_id: evt.event_id,
        user_id: evt.user_id,
        channel_id: evt.channel_id,
        prompt_version: PROMPT_VERSION,
        llm_calls: result.llm_calls,
        tool_calls: result.tool_calls,
        halt_reason: result.halt_reason,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost_usd: Number(result.cost_usd.toFixed(6)),
        latency_ms: result.latency_ms,
        context_trace: packed.trace,
      },
      'turn_done',
    );

    m_turns_total.inc({
      outcome: result.halt_reason === 'final_text' ? 'done' : 'halted',
      channel_type: evt.channel_type,
    });
    m_turn_latency.observe(result.latency_ms / 1000);
    m_llm_tokens.inc({ model: PROMPT_VERSION, kind: 'input' }, result.tokens_in);
    m_llm_tokens.inc({ model: PROMPT_VERSION, kind: 'output' }, result.tokens_out);
    m_llm_cost_usd.inc({ model: PROMPT_VERSION }, result.cost_usd);

    await reply.finalize(result.text, { useCanvasIfLong: true });
    await recordReplied(evt.event_id, turn_id, evt.channel_id, reply.getMessageTs());
    const replyThreadTs = reply.getThreadTs();
    if (replyThreadTs) await markThreadActive(redis, replyThreadTs);

    void track(
      logAudit({
        actor: 'agent',
        action: 'turn_replied',
        payload: {
          turn_id,
          event_id: evt.event_id,
          user_id: evt.user_id,
          channel_id: evt.channel_id,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          cost_usd: result.cost_usd,
          tool_calls: result.tool_calls,
          halt_reason: result.halt_reason,
          reply_excerpt: result.text.slice(0, 500),
        },
      }),
    );

    persistSuccessfulTurn({
      evt,
      turn_id,
      effectiveThreadTs,
      systemContent,
      contextBlocks: packed.blocks,
      userText,
      result,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event_id: evt.event_id, turn_id },
      'turn handler failed',
    );
    await postReply(evt, '⚠️ Sorry — turn handler crashed. Check logs.');
    await recordReplied(evt.event_id, turn_id);
    m_turns_total.inc({ outcome: 'errored', channel_type: evt.channel_type });
    persistErroredTurn({
      evt,
      turn_id,
      effectiveThreadTs,
      systemContent,
      contextBlocks: packed.blocks,
      userText,
      errorMessage: (err as Error).message,
    });
  }
}
