import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { facts } from '../db/schema.js';
import { embedOne } from '../llm/embed.js';

export interface FactRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  last_seen_at: Date;
}

export async function getFactsForUser(user_id: string, limit = 50): Promise<FactRow[]> {
  if (!isMemoryEnabled()) return [];
  const db = getDb();
  return db
    .select({
      id: facts.id,
      subject: facts.subject,
      predicate: facts.predicate,
      object: facts.object,
      confidence: facts.confidence,
      last_seen_at: facts.last_seen_at,
    })
    .from(facts)
    .where(
      and(
        eq(facts.scope, 'user'),
        eq(facts.scope_id, user_id),
        eq(facts.contradicted, false),
      ),
    )
    .orderBy(desc(facts.last_seen_at))
    .limit(limit);
}

export async function forgetFacts(user_id: string, topic: string): Promise<{ count: number }> {
  if (!isMemoryEnabled()) return { count: 0 };
  const db = getDb();
  const pattern = `%${topic}%`;
  const result = await db
    .update(facts)
    .set({ contradicted: true })
    .where(
      and(
        eq(facts.scope, 'user'),
        eq(facts.scope_id, user_id),
        sql`(subject ILIKE ${pattern} OR object ILIKE ${pattern} OR predicate ILIKE ${pattern})`,
      ),
    )
    .returning({ id: facts.id });
  return { count: result.length };
}

export async function rememberPinned(user_id: string, factText: string): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  const vec = await embedOne(factText);
  await db.insert(facts).values({
    subject: `user:${user_id}`,
    predicate: 'pinned',
    object: factText,
    confidence: 1.0,
    scope: 'user',
    scope_id: user_id,
    pinned: true,
    embedding: vec,
  });
}
