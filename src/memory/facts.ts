import { getDb, getRawClient, isMemoryEnabled } from '../db/index.js';
import { facts } from '../db/schema.js';
import { llm, llmModel } from '../llm/client.js';
import { embedOne } from '../llm/embed.js';
import { logger } from '../logger.js';

export type Scope = 'user' | 'channel' | 'global';

export interface FactCandidate {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  scope: Scope;
}

const EXTRACTOR_PROMPT = `Extract durable facts from this conversation turn as SVO triples.
Schema per fact:
- subject: who/what the fact is about
- predicate: relation/attribute
- object: value
- confidence: 0..1
- scope: "user" (about the speaker), "channel" (about the project/team), "global" (general knowledge)

Rules:
- Skip transient ("I'm tired today"), assistant-internal, or fabricated facts.
- Only extract facts grounded in the text.
- 0–5 facts.

Return JSON: { "facts": [{ subject, predicate, object, confidence, scope }] }`;

const MERGE_PROMPT = `Two candidate facts. Decide:
- "duplicate": semantically same → keep old, drop new
- "update": new is more precise/recent → replace old
- "contradicts": they conflict → mark old contradicted, keep new
- "different": actually different facts despite similar wording → keep both (insert new)

Return JSON: { "decision": "..." }`;

interface MergeDecision {
  decision: 'duplicate' | 'update' | 'contradicts' | 'different';
}

interface ExtractedFacts {
  facts?: FactCandidate[];
}

function pgVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function extractFactsFromTurn(opts: {
  userText: string;
  assistantText: string;
}): Promise<FactCandidate[]> {
  try {
    const resp = await llm.chat.completions.create({
      model: llmModel,
      messages: [
        { role: 'system', content: EXTRACTOR_PROMPT },
        {
          role: 'user',
          content: `User: ${opts.userText}\n\nAssistant: ${opts.assistantText}`,
        },
      ],
      response_format: { type: 'json_object' },
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as ExtractedFacts;
    return (parsed.facts ?? [])
      .filter((f) => f.confidence >= 0.5)
      .filter((f) => f.subject && f.predicate && f.object);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fact extraction failed');
    return [];
  }
}

interface NearestFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  sim: number;
}

async function decideMerge(
  candidate: FactCandidate,
  nearest: NearestFact,
): Promise<MergeDecision['decision']> {
  try {
    const resp = await llm.chat.completions.create({
      model: llmModel,
      messages: [
        { role: 'system', content: MERGE_PROMPT },
        {
          role: 'user',
          content: `Old: ${nearest.subject} | ${nearest.predicate} | ${nearest.object}\nNew: ${candidate.subject} | ${candidate.predicate} | ${candidate.object}`,
        },
      ],
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}') as MergeDecision;
    return parsed.decision ?? 'duplicate';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fact merge decision failed');
    return 'duplicate';
  }
}

export async function storeFact(
  candidate: FactCandidate,
  source_turn_id: string,
  scope_id: string,
): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  const sql = getRawClient();
  const vec = await embedOne(
    `${candidate.subject} ${candidate.predicate} ${candidate.object}`,
  );
  const literal = pgVectorLiteral(vec);

  // Nearest neighbor in same scope
  const nearestRows = await sql<NearestFact[]>`
    SELECT id, subject, predicate, object,
           1 - (embedding <=> ${literal}::vector) AS sim
    FROM facts
    WHERE scope = ${candidate.scope}
      AND scope_id = ${scope_id}
      AND contradicted = false
    ORDER BY embedding <=> ${literal}::vector
    LIMIT 1
  `;
  const nearest = nearestRows[0];

  if (nearest && nearest.sim > 0.92) {
    const decision = await decideMerge(candidate, nearest);
    if (decision === 'duplicate') {
      await sql`
        UPDATE facts
        SET last_seen_at = now()
        WHERE id = ${nearest.id}::uuid
      `;
      return;
    }
    if (decision === 'update') {
      await sql`
        UPDATE facts
        SET subject = ${candidate.subject},
            predicate = ${candidate.predicate},
            object = ${candidate.object},
            confidence = ${candidate.confidence},
            embedding = ${literal}::vector,
            source_turn_id = ${source_turn_id}::uuid,
            last_seen_at = now()
        WHERE id = ${nearest.id}::uuid
      `;
      return;
    }
    if (decision === 'contradicts') {
      await sql`UPDATE facts SET contradicted = true WHERE id = ${nearest.id}::uuid`;
      // fall through to insert as new
    }
    // 'different' → insert new
  }

  await db.insert(facts).values({
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    confidence: candidate.confidence,
    source_turn_id,
    scope: candidate.scope,
    scope_id,
    embedding: vec,
  });
}

export interface FactSearchResult {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sim: number;
}

export async function searchFactsByEmbedding(
  queryVec: number[],
  scope: Scope,
  scope_id: string,
  limit = 8,
): Promise<FactSearchResult[]> {
  if (!isMemoryEnabled()) return [];
  const sql = getRawClient();
  const literal = pgVectorLiteral(queryVec);
  const rows = await sql<FactSearchResult[]>`
    SELECT subject, predicate, object, confidence,
           1 - (embedding <=> ${literal}::vector) AS sim
    FROM facts
    WHERE scope = ${scope}
      AND scope_id = ${scope_id}
      AND contradicted = false
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
  return rows.filter((r) => r.sim > 0.3); // weak relevance cutoff
}

export async function decayConfidence(): Promise<{ decayed: number; soft_deleted: number }> {
  if (!isMemoryEnabled()) return { decayed: 0, soft_deleted: 0 };
  const sql = getRawClient();
  const decayed = await sql<{ count: number }[]>`
    WITH touched AS (
      UPDATE facts
      SET confidence = confidence * 0.8
      WHERE last_seen_at < now() - interval '60 days'
        AND confidence < 1.0
        AND contradicted = false
        AND pinned = false
      RETURNING id
    )
    SELECT count(*)::int AS count FROM touched
  `;
  const softDeleted = await sql<{ count: number }[]>`
    WITH touched AS (
      UPDATE facts
      SET contradicted = true
      WHERE confidence < 0.1
        AND contradicted = false
        AND pinned = false
      RETURNING id
    )
    SELECT count(*)::int AS count FROM touched
  `;
  return {
    decayed: decayed[0]?.count ?? 0,
    soft_deleted: softDeleted[0]?.count ?? 0,
  };
}
