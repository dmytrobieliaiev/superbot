// Write-path for a completed turn: trajectory, episodic assistant message,
// fact extraction, thread-summary trigger, skill miner. All fire-and-forget
// via `track()` so the reply latency is not blocked on persistence.

import { isMemoryEnabled } from '../db/index.js';
import { track } from '../lifecycle.js';
import { logAudit } from '../audit.js';
import { logger } from '../logger.js';
import { extractFactsFromTurn, storeFact } from '../memory/facts.js';
import { mineSkillFromTrajectory, storeSkill } from '../memory/skills.js';
import { maybeUpdateThreadSummary } from '../memory/summary.js';
import { countThreadTurns } from '../memory/recent.js';
import { writeEpisodic } from '../memory/episodic.js';
import { inferOutcome, writeTrajectory } from '../memory/trajectory.js';
import type { EnrichedEvent } from '../slack/types.js';
import type { ToolLoopResult } from './tool-loop.js';

export interface PersistArgs {
  evt: EnrichedEvent;
  turn_id: string;
  effectiveThreadTs: string;
  systemContent: string;
  contextBlocks: string[];
  userText: string;
  result: ToolLoopResult;
}

/** Persist all derived artifacts after a successful turn. */
export function persistSuccessfulTurn(args: PersistArgs): void {
  if (!isMemoryEnabled()) return;
  const { evt, turn_id, effectiveThreadTs, systemContent, contextBlocks, userText, result } = args;

  void track(
    writeTrajectory({
      turn_id,
      event_id: evt.event_id,
      user_id: evt.user_id,
      channel_id: evt.channel_id,
      thread_ts: effectiveThreadTs,
      full_log: {
        system_prompt_excerpt: systemContent.slice(0, 1500),
        context_blocks: contextBlocks,
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

  void track(
    (async () => {
      const count = await countThreadTurns(effectiveThreadTs);
      await maybeUpdateThreadSummary(effectiveThreadTs, evt.channel_id, count);
    })().catch((err: unknown) =>
      logger.warn({ err: (err as Error).message }, 'summary trigger failed'),
    ),
  );

  // Skill miner — gated on ≥3 tool calls + clean halt
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

export interface ErroredPersistArgs {
  evt: EnrichedEvent;
  turn_id: string;
  effectiveThreadTs: string;
  systemContent: string;
  contextBlocks: string[];
  userText: string;
  errorMessage: string;
}

/** Persist trajectory for an errored turn so we can replay/debug later. */
export function persistErroredTurn(args: ErroredPersistArgs): void {
  if (!isMemoryEnabled()) return;
  const { evt, turn_id, effectiveThreadTs, systemContent, contextBlocks, userText, errorMessage } =
    args;
  void track(
    writeTrajectory({
      turn_id,
      event_id: evt.event_id,
      user_id: evt.user_id,
      channel_id: evt.channel_id,
      thread_ts: effectiveThreadTs,
      full_log: {
        system_prompt_excerpt: systemContent.slice(0, 1500),
        context_blocks: contextBlocks,
        user_text: userText,
        assistant_text: `ERROR: ${errorMessage}`,
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
