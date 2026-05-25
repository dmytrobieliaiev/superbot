import { getDb, isMemoryEnabled } from '../db/index.js';
import { message_chunks, messages } from '../db/schema.js';
import { embed } from '../llm/embed.js';
import { logger } from '../logger.js';
import { chunkText } from './chunk.js';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface TurnMessageInput {
  turn_id: string;
  channel_id: string;
  user_id: string;
  thread_ts?: string;
  role: Role;
  content: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  tokens?: number;
  cost_usd?: number;
  latency_ms?: number;
}

/**
 * Persist a single message from a turn. Chunks content + embeds in background.
 * Returns the inserted message id.
 */
export async function writeEpisodic(turn: TurnMessageInput): Promise<string | null> {
  if (!isMemoryEnabled()) return null;
  const db = getDb();

  const inserted = await db
    .insert(messages)
    .values({
      turn_id: turn.turn_id,
      channel_id: turn.channel_id,
      user_id: turn.user_id,
      thread_ts: turn.thread_ts ?? null,
      role: turn.role,
      content: turn.content,
      tool_calls: turn.tool_calls ?? null,
      tool_results: turn.tool_results ?? null,
      tokens: turn.tokens ?? 0,
      cost_usd: turn.cost_usd ?? 0,
      latency_ms: turn.latency_ms ?? null,
    })
    .returning({ id: messages.id });

  const row = inserted[0];
  if (!row) return null;

  // Chunk + embed asynchronously (don't block return). Errors logged, not thrown.
  void chunkAndEmbed(row.id, turn.content).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), message_id: row.id },
      'chunk+embed failed (message stored without vectors)',
    );
  });

  return row.id;
}

async function chunkAndEmbed(message_id: string, content: string): Promise<void> {
  const db = getDb();
  const chunks = chunkText(content);
  if (chunks.length === 0) return;

  const embeddings = await embed(chunks);
  await db.insert(message_chunks).values(
    chunks.map((c, i) => ({
      message_id,
      chunk_index: i,
      content: c,
      embedding: embeddings[i] ?? null,
    })),
  );
}
