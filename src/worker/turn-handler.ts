import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { turn_state } from '../db/schema.js';
import { track } from '../lifecycle.js';
import { critiqueResponse, formatCriticFeedbackBlock } from '../llm/critic.js';
import { embedOne } from '../llm/embed.js';
import { PROMPT_VERSION, renderSystemPrompt } from '../llm/prompt.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../logger.js';
import {
  m_critic_action,
  m_critic_attempts,
  m_llm_cost_usd,
  m_llm_tokens,
  m_turn_latency,
  m_turns_total,
} from '../metrics.js';
import { writeEpisodic } from '../memory/episodic.js';
import { extractFactsFromTurn, searchFactsByEmbedding, storeFact } from '../memory/facts.js';
import { packMemory } from '../memory/packer.js';
import { getUserProfile, syncUserProfile } from '../memory/profile.js';
import { searchEpisodicByEmbedding } from '../memory/recall.js';
import { countThreadTurns, getRecentTurns, type RecentTurn } from '../memory/recent.js';
import { mineSkillFromTrajectory, searchSkillsByEmbedding, storeSkill } from '../memory/skills.js';
import { getThreadSummary, maybeUpdateThreadSummary } from '../memory/summary.js';
import { inferOutcome, writeTrajectory } from '../memory/trajectory.js';
import { postReply, ProgressiveReply } from '../slack/output.js';
import { markThreadActive } from '../slack/reactions.js';
import type { EnrichedEvent } from '../slack/types.js';
import type { ToolContext } from '../tools/types.js';
import { runToolLoop } from './tool-loop.js';

const LOCK_RETRY_DELAY_MS = 3000;

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

function backlogAsRecentTurns(evt: EnrichedEvent): RecentTurn[] {
  return (evt.thread_backlog ?? []).map((m) => ({
    role: 'user',
    content: m.text,
    ts: new Date(Number(m.ts) * 1000),
    user_id: m.user,
  }));
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

  // Effective thread root — bot always replies in a thread, rooted at the
  // user's first message when no thread exists yet. Use this for BOTH writes
  // and reads of episodic memory so a first @mention's text is retrievable
  // when the user replies in the just-created thread.
  const effectiveThreadTs = evt.thread_ts ?? evt.ts;

  // Read path — parallel fanout
  const queryVecPromise: Promise<number[] | null> = memoryOn
    ? embedOne(userText).catch(() => null)
    : Promise.resolve(null);

  const [profile, recentTurns, threadSummary, queryVec] = memoryOn
    ? await Promise.all([
        getUserProfile(evt.user_id).catch(() => undefined),
        getRecentTurns(evt.channel_id, effectiveThreadTs, 10).catch(() => []),
        getThreadSummary(effectiveThreadTs).catch(() => undefined),
        queryVecPromise,
      ])
    : [undefined, backlogAsRecentTurns(evt), undefined, null];

  const [factsHits, episodicHits, skillsHits] =
    memoryOn && queryVec
      ? await Promise.all([
          searchFactsByEmbedding(queryVec, 'user', evt.user_id, 8).catch(() => []),
          searchEpisodicByEmbedding(queryVec, evt.user_id, 5).catch(() => []),
          searchSkillsByEmbedding(queryVec, 3).catch(() => []),
        ])
      : [[], [], []];

  const packed = packMemory({
    user_profile: profile,
    recent_turns: recentTurns,
    thread_summary: threadSummary,
    facts: factsHits,
    episodic_recall: episodicHits,
    skills: skillsHits,
  });

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

  // (3) Persist user message synchronously BEFORE LLM call so later turns
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
    const result = await runToolLoop({
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

    // Critic loop — review + retry on weak output. Skipped via CRITIC_ENABLED=false
    // or CRITIC_MODE='on_negative' (default; runs only when user reacts negatively).
    let attempts = 1;
    if (env.CRITIC_ENABLED && env.CRITIC_MODE === 'inline') {
      while (attempts <= env.CRITIC_MAX_RETRIES + 1) {
        const critique = await critiqueResponse({
          userInput: userText,
          agentResponse: result.text,
          contextSummary: packed.blocks.join('\n\n').slice(0, 4000),
        });
        m_critic_action.inc({ action: critique.action });
        logger.info(
          {
            turn_id,
            attempt: attempts,
            helpful: critique.helpful,
            correct: critique.correct,
            grounded: critique.grounded,
            action: critique.action,
          },
          'critic_review',
        );
        void track(
          logAudit({
            actor: 'agent',
            action: 'critic_review',
            payload: {
              turn_id,
              attempt: attempts,
              helpful: critique.helpful,
              correct: critique.correct,
              grounded: critique.grounded,
              action: critique.action,
              caveat: critique.caveat,
              feedback: critique.feedback,
            },
          }),
        );

        if (critique.action === 'ship') break;

        if (critique.action === 'ship_with_caveat') {
          if (critique.caveat) {
            result.text = `${result.text}\n\n_⚠️ ${critique.caveat}_`;
          }
          break;
        }

        // action === 'retry'
        if (attempts > env.CRITIC_MAX_RETRIES) {
          logger.warn(
            { turn_id, attempts },
            'critic_max_retries_reached_shipping_anyway',
          );
          break;
        }
        attempts++;
        await reply.update('🔄 Reconsidering with reviewer feedback…', { force: true });

        const feedbackBlock = formatCriticFeedbackBlock(critique);
        const retry = await runToolLoop({
          redis,
          ctx,
          systemPrompt: systemContent,
          contextBlocks: [...packed.blocks, feedbackBlock],
          userText,
          onProgress: (_delta, accumulated) => {
            void reply.update(accumulated);
          },
        });

        // Accumulate metrics from retry
        result.tokens_in += retry.tokens_in;
        result.tokens_out += retry.tokens_out;
        result.cost_usd += retry.cost_usd;
        result.latency_ms += retry.latency_ms;
        result.llm_calls += retry.llm_calls;
        result.tool_calls += retry.tool_calls;
        result.tool_executions.push(...retry.tool_executions);
        result.text = retry.text;
      }
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

    // M11.3 metrics
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

    if (memoryOn) {
      void track(
        writeTrajectory({
          turn_id,
          event_id: evt.event_id,
          user_id: evt.user_id,
          channel_id: evt.channel_id,
          thread_ts: effectiveThreadTs,
          full_log: {
            system_prompt_excerpt: systemContent.slice(0, 1500),
            context_blocks: packed.blocks,
            user_text: userText,
            assistant_text: result.text,
            tool_executions: result.tool_executions,
          },
          outcome: inferOutcome(result.halt_reason, false),
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          cost_usd: result.cost_usd,
          latency_ms: result.latency_ms,
          llm_calls: result.llm_calls,
          tool_calls: result.tool_calls,
          halt_reason: result.halt_reason,
        }).catch((err: unknown) =>
          logger.warn({ err: (err as Error).message }, 'writeTrajectory failed'),
        ),
      );

      void track(
        writeEpisodic({
          turn_id,
          channel_id: evt.channel_id,
          user_id: evt.user_id,
          thread_ts: effectiveThreadTs,
          role: 'assistant',
          content: result.text,
          tokens: result.tokens_in + result.tokens_out,
          cost_usd: result.cost_usd,
          latency_ms: result.latency_ms,
        }).catch((err: unknown) =>
          logger.warn({ err: (err as Error).message }, 'episodic assistant write failed'),
        ),
      );

      void track(
        (async () => {
          const candidates = await extractFactsFromTurn({
            userText,
            assistantText: result.text,
          });
          for (const c of candidates) {
            const scope_id = c.scope === 'user' ? evt.user_id : evt.channel_id;
            await storeFact(c, turn_id, scope_id);
          }
          if (candidates.length > 0) {
            logger.info({ turn_id, facts_stored: candidates.length }, 'facts_extracted');
          }
        })().catch((err: unknown) =>
          logger.warn({ err: (err as Error).message }, 'fact extraction job failed'),
        ),
      );

      {
        const threadTs = effectiveThreadTs;
        void track(
          (async () => {
            const count = await countThreadTurns(threadTs);
            await maybeUpdateThreadSummary(threadTs, evt.channel_id, count);
          })().catch((err: unknown) =>
            logger.warn({ err: (err as Error).message }, 'summary trigger failed'),
          ),
        );
      }

      // M10.2: skill miner (gated on ≥3 tool calls + success)
      if (result.halt_reason === 'final_text' && result.tool_calls >= 3) {
        void track(
          (async () => {
            const mined = await mineSkillFromTrajectory({
              user_text: userText,
              assistant_text: result.text,
              tool_executions: result.tool_executions,
            });
            if (mined) {
              await storeSkill(mined);
              logger.info({ turn_id, skill_name: mined.name }, 'skill_mined');
              await logAudit({
                actor: 'agent',
                action: 'skill_mined',
                payload: { turn_id, skill_name: mined.name },
              });
            }
          })().catch((err: unknown) =>
            logger.warn({ err: (err as Error).message }, 'skill_miner_failed'),
          ),
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event_id: evt.event_id, turn_id },
      'turn handler failed',
    );
    await postReply(evt, '⚠️ Sorry — turn handler crashed. Check logs.');
    await recordReplied(evt.event_id, turn_id);
    m_turns_total.inc({ outcome: 'errored', channel_type: evt.channel_type });
    if (memoryOn) {
      void track(
        writeTrajectory({
          turn_id,
          event_id: evt.event_id,
          user_id: evt.user_id,
          channel_id: evt.channel_id,
          thread_ts: effectiveThreadTs,
          full_log: {
            system_prompt_excerpt: systemContent.slice(0, 1500),
            context_blocks: packed.blocks,
            user_text: userText,
            assistant_text: `ERROR: ${(err as Error).message}`,
            tool_executions: [],
          },
          outcome: inferOutcome('errored', true),
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          latency_ms: 0,
          llm_calls: 0,
          tool_calls: 0,
          halt_reason: 'exception',
        }).catch(() => undefined),
      );
    }
  }
}
