import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { messages } from '../db/schema.js';

export interface RecentTurn {
  role: string;
  content: string;
  ts: Date;
  user_id: string;
}

/**
 * Load last K messages in thread (or channel if no thread). Newest-first then
 * reversed so the LLM sees chronological order.
 */
export async function getRecentTurns(
  channel_id: string,
  thread_ts: string | undefined,
  k = 10,
): Promise<RecentTurn[]> {
  if (!isMemoryEnabled()) return [];
  const db = getDb();

  const rows = thread_ts
    ? await db
        .select()
        .from(messages)
        .where(eq(messages.thread_ts, thread_ts))
        .orderBy(desc(messages.ts))
        .limit(k)
    : await db
        .select()
        .from(messages)
        .where(and(eq(messages.channel_id, channel_id), isNull(messages.thread_ts)))
        .orderBy(desc(messages.ts))
        .limit(k);

  return rows.reverse().map((r) => ({
    role: r.role,
    content: r.content,
    ts: r.ts,
    user_id: r.user_id,
  }));
}

export async function countThreadTurns(thread_ts: string): Promise<number> {
  if (!isMemoryEnabled()) return 0;
  const db = getDb();
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.thread_ts, thread_ts));
  return rows.length;
}
