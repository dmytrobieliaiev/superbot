// Negative-reaction-triggered critic + retry path.
// Looks up the original turn by (channel_id, bot_msg_ts), critiques the prior
// agent reply, re-runs the tool loop with critic feedback in context, and
// posts a correction in-thread linked to the original.

import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { trajectories, turn_state } from '../db/schema.js';
import { critiqueResponse, formatCriticFeedbackBlock } from '../llm/critic.js';
import { PROMPT_VERSION, renderSystemPrompt } from '../llm/prompt.js';
import { logger } from '../logger.js';
import { slackClient } from '../slack/client.js';
import type { ToolContext } from '../tools/types.js';
import { runToolLoop } from './tool-loop.js';

export interface CriticRetryArgs {
  redis: Redis;
  channelId: string;
  botMsgTs: string;
  reactor: string;       // who pressed thumbsdown
  reaction: string;      // e.g. 'thumbsdown'
}

export async function critiqueAndRetry(args: CriticRetryArgs): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();

  // 1. Locate originating turn
  const stateRows = await db
    .select()
    .from(turn_state)
    .where(
      and(
        eq(turn_state.channel_id, args.channelId),
        eq(turn_state.bot_msg_ts, args.botMsgTs),
      ),
    )
    .limit(1);
  const state = stateRows[0];
  if (!state) {
    logger.info(
      { channel: args.channelId, msg_ts: args.botMsgTs },
      'critic_retry_no_turn_state',
    );
    return;
  }

  // 2. Load trajectory
  const trajRows = await db
    .select()
    .from(trajectories)
    .where(eq(trajectories.turn_id, state.turn_id))
    .limit(1);
  const traj = trajRows[0];
  if (!traj) {
    logger.info({ turn_id: state.turn_id }, 'critic_retry_no_trajectory');
    return;
  }
  const log = traj.full_log as {
    user_text?: string;
    assistant_text?: string;
    tool_executions?: Array<{ name: string; result_excerpt: string; status: string }>;
    context_blocks?: string[];
  };
  if (!log.user_text || !log.assistant_text) {
    logger.info({ turn_id: state.turn_id }, 'critic_retry_no_log_text');
    return;
  }

  // 3. Build context summary including tool excerpts (the grounding evidence)
  const toolSummary = (log.tool_executions ?? [])
    .map(
      (t) =>
        `[tool ${t.name} ${t.status}] ${t.result_excerpt.slice(0, 600)}`,
    )
    .join('\n\n');
  const contextSummary = [
    ...(log.context_blocks ?? []).slice(0, 4),
    toolSummary ? `tool results:\n${toolSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 6000);

  // 4. Critique
  const critique = await critiqueResponse({
    userInput: log.user_text,
    agentResponse: log.assistant_text,
    contextSummary,
  });
  logger.info(
    {
      turn_id: state.turn_id,
      helpful: critique.helpful,
      correct: critique.correct,
      grounded: critique.grounded,
      action: critique.action,
      reactor: args.reactor,
      reaction: args.reaction,
    },
    'critic_retry_review',
  );
  await logAudit({
    actor: 'agent',
    action: 'critic_retry_review',
    payload: {
      turn_id: state.turn_id,
      reactor: args.reactor,
      reaction: args.reaction,
      helpful: critique.helpful,
      correct: critique.correct,
      grounded: critique.grounded,
      action: critique.action,
      feedback: critique.feedback,
      caveat: critique.caveat,
    },
  });

  const client = slackClient();
  if (critique.action === 'ship') {
    // Critic says original was fine — but user disliked. Surface the disagreement.
    await client.chat.postMessage({
      channel: args.channelId,
      thread_ts: args.botMsgTs,
      text:
        `Reviewer rated the previous reply as helpful=${critique.helpful}/3 correct=${critique.correct}/3 grounded=${critique.grounded}/3.\n` +
        `It would not change the answer. Tell me specifically what's wrong and I'll retry.`,
    });
    return;
  }

  if (critique.action === 'ship_with_caveat' && critique.caveat) {
    await client.chat.postMessage({
      channel: args.channelId,
      thread_ts: args.botMsgTs,
      text: `Reviewer caveat: _⚠️ ${critique.caveat}_`,
    });
    return;
  }

  // 5. Retry tool loop with critic feedback
  const systemContent = renderSystemPrompt({ user: traj.user_id });
  const ctx: ToolContext = {
    turn_id: state.turn_id,
    user_id: traj.user_id,
    channel_id: traj.channel_id,
    channel_type: 'channel',
    ...(traj.thread_ts ? { thread_ts: traj.thread_ts } : { thread_ts: args.botMsgTs }),
  };
  const feedbackBlock = formatCriticFeedbackBlock(critique);
  const retry = await runToolLoop({
    redis: args.redis,
    ctx,
    systemPrompt: systemContent,
    contextBlocks: [...(log.context_blocks ?? []), feedbackBlock],
    userText: log.user_text,
  });

  // 6. Post correction in-thread, link to original
  await client.chat.postMessage({
    channel: args.channelId,
    thread_ts: traj.thread_ts ?? args.botMsgTs,
    text:
      `🔁 *Revised reply* (reviewer feedback applied):\n\n${retry.text}\n\n` +
      `_orig msg ts: ${args.botMsgTs}_`,
  });

  await logAudit({
    actor: 'agent',
    action: 'critic_retry_posted',
    payload: {
      turn_id: state.turn_id,
      original_msg_ts: args.botMsgTs,
      retry_tokens_in: retry.tokens_in,
      retry_tokens_out: retry.tokens_out,
      retry_cost_usd: retry.cost_usd,
      retry_latency_ms: retry.latency_ms,
      prompt_version: PROMPT_VERSION,
    },
  });
}
