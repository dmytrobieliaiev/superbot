import { asc, eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { messages, thread_summary } from '../db/schema.js';
import { llm, llmModel } from '../llm/client.js';
import { logger } from '../logger.js';

const SUMMARY_EVERY_N_TURNS = 20;
const KEEP_VERBATIM = 10;

export async function getThreadSummary(thread_ts: string): Promise<string | undefined> {
  if (!isMemoryEnabled()) return undefined;
  const db = getDb();
  const rows = await db
    .select()
    .from(thread_summary)
    .where(eq(thread_summary.thread_ts, thread_ts))
    .limit(1);
  return rows[0]?.summary;
}

/**
 * Compress older turns in a thread into a rolling summary. Triggered every N turns.
 * Keeps last KEEP_VERBATIM turns untouched (they're loaded by recent retrieval).
 */
export async function maybeUpdateThreadSummary(
  thread_ts: string,
  channel_id: string,
  turn_count: number,
): Promise<void> {
  if (!isMemoryEnabled()) return;
  if (turn_count < SUMMARY_EVERY_N_TURNS) return;
  if (turn_count % SUMMARY_EVERY_N_TURNS !== 0) return;

  const db = getDb();
  const all = await db
    .select()
    .from(messages)
    .where(eq(messages.thread_ts, thread_ts))
    .orderBy(asc(messages.ts));

  if (all.length <= KEEP_VERBATIM) return;
  const toSummarize = all.slice(0, -KEEP_VERBATIM);
  const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join('\n');

  try {
    const resp = await llm.chat.completions.create({
      model: llmModel,
      messages: [
        {
          role: 'system',
          content:
            'Compress this conversation into a chronological summary. Keep facts, decisions, names, unresolved threads. ≤500 words. Do not invent details.',
        },
        { role: 'user', content: transcript },
      ],
    });
    const summary = resp.choices[0]?.message?.content ?? '';
    if (!summary) return;

    await db
      .insert(thread_summary)
      .values({
        thread_ts,
        channel_id,
        summary,
        turn_count,
      })
      .onConflictDoUpdate({
        target: thread_summary.thread_ts,
        set: {
          summary,
          turn_count,
          updated_at: new Date(),
        },
      });
    logger.info({ thread_ts, turn_count, summary_chars: summary.length }, 'thread summarized');
  } catch (err) {
    logger.warn({ err: (err as Error).message, thread_ts }, 'thread summary failed');
  }
}
