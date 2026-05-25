// Inline critic loop: runs after the initial tool-loop reply when
// CRITIC_MODE='inline'. Reviews + optionally retries the response w/ feedback.
// Default mode is 'on_negative' (see slack/reactions.ts) — this path is legacy.

import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { env } from '../config/env.js';
import { track } from '../lifecycle.js';
import { critiqueResponse, formatCriticFeedbackBlock } from '../llm/critic.js';
import { logger } from '../logger.js';
import { m_critic_action } from '../metrics.js';
import type { ProgressiveReply } from '../slack/output.js';
import type { ToolContext } from '../tools/types.js';
import { runToolLoop, type ToolLoopResult } from './tool-loop.js';

export interface InlineCriticArgs {
  redis: Redis;
  ctx: ToolContext;
  reply: ProgressiveReply;
  systemPrompt: string;
  contextBlocks: string[];
  userText: string;
  result: ToolLoopResult;
  turn_id: string;
}

export interface InlineCriticOutcome {
  attempts: number;
  /** Mutated in place: result.text may be updated, costs accumulated. */
  result: ToolLoopResult;
}

export async function runInlineCritic(args: InlineCriticArgs): Promise<InlineCriticOutcome> {
  const { redis, ctx, reply, systemPrompt, contextBlocks, userText, turn_id } = args;
  const result = args.result;
  let attempts = 1;

  while (attempts <= env.CRITIC_MAX_RETRIES + 1) {
    const critique = await critiqueResponse({
      userInput: userText,
      agentResponse: result.text,
      contextSummary: contextBlocks.join('\n\n').slice(0, 4000),
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
      systemPrompt,
      contextBlocks: [...contextBlocks, feedbackBlock],
      userText,
      onProgress: (_delta, accumulated) => {
        void reply.update(accumulated);
      },
    });

    // Accumulate metrics from retry into the original result
    result.tokens_in += retry.tokens_in;
    result.tokens_out += retry.tokens_out;
    result.cost_usd += retry.cost_usd;
    result.latency_ms += retry.latency_ms;
    result.llm_calls += retry.llm_calls;
    result.tool_calls += retry.tool_calls;
    result.tool_executions.push(...retry.tool_executions);
    result.text = retry.text;
  }

  return { attempts, result };
}
