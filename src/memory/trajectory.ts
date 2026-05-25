import { getDb, isMemoryEnabled } from '../db/index.js';
import { trajectories } from '../db/schema.js';

export type Outcome = 'done' | 'errored' | 'halted' | 'abandoned';

export interface ToolExecRecord {
  name: string;
  args: unknown;
  result_excerpt: string;
  status: string;
  latency_ms: number;
  cost_usd: number;
  cache_hit: boolean;
}

export interface TrajectoryRow {
  turn_id: string;
  event_id: string;
  user_id: string;
  channel_id: string;
  thread_ts?: string;
  full_log: {
    system_prompt_excerpt: string;
    context_blocks: string[];
    user_text: string;
    assistant_text: string;
    tool_executions: ToolExecRecord[];
  };
  outcome: Outcome;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  llm_calls: number;
  tool_calls: number;
  halt_reason: string;
}

const MAX_FULL_LOG_JSON_BYTES = 1_000_000; // 1 MB cap on JSONB row size
const TOOL_RESULT_EXCERPT_TRUNCATE = 500;

/**
 * Bound the size of full_log before insert. Tool result excerpts can balloon
 * trajectory rows into multi-MB JSONB entries — cap to ~1 MB by truncating
 * tool result excerpts and context blocks if needed.
 */
function boundFullLog(full_log: TrajectoryRow['full_log']): TrajectoryRow['full_log'] {
  const bounded = {
    ...full_log,
    tool_executions: full_log.tool_executions.map((t) => ({
      ...t,
      result_excerpt: t.result_excerpt.slice(0, TOOL_RESULT_EXCERPT_TRUNCATE),
    })),
  };
  const size = Buffer.byteLength(JSON.stringify(bounded), 'utf-8');
  if (size <= MAX_FULL_LOG_JSON_BYTES) return bounded;

  // Still too big — drop most expensive fields progressively
  return {
    ...bounded,
    context_blocks: bounded.context_blocks.map((b) => b.slice(0, 200)),
    assistant_text: bounded.assistant_text.slice(0, 5000),
    tool_executions: bounded.tool_executions.map((t) => ({
      ...t,
      result_excerpt: t.result_excerpt.slice(0, 100),
      args: '[truncated]',
    })),
  };
}

export async function writeTrajectory(row: TrajectoryRow): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  await db
    .insert(trajectories)
    .values({
      turn_id: row.turn_id,
      event_id: row.event_id,
      user_id: row.user_id,
      channel_id: row.channel_id,
      thread_ts: row.thread_ts ?? null,
      full_log: boundFullLog(row.full_log),
      outcome: row.outcome,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      llm_calls: row.llm_calls,
      tool_calls: row.tool_calls,
      halt_reason: row.halt_reason,
    })
    .onConflictDoNothing({ target: trajectories.turn_id });
}

export function inferOutcome(haltReason: string, errored: boolean): Outcome {
  if (errored) return 'errored';
  if (haltReason === 'final_text') return 'done';
  if (haltReason === 'max_iterations') return 'halted';
  return 'abandoned';
}
