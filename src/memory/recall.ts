import { getRawClient, isMemoryEnabled } from '../db/index.js';

interface EpisodicHit {
  chunk_content: string;
  message_role: string;
  message_ts: Date;
  sim: number;
}

function pgVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Cross-thread episodic recall by embedding similarity, scoped to a user.
 * Returns top-K message chunks with their parent message metadata.
 */
export async function searchEpisodicByEmbedding(
  queryVec: number[],
  user_id: string,
  limit = 5,
): Promise<EpisodicHit[]> {
  if (!isMemoryEnabled()) return [];
  const sql = getRawClient();
  const literal = pgVectorLiteral(queryVec);
  const rows = await sql<EpisodicHit[]>`
    SELECT c.content AS chunk_content,
           m.role AS message_role,
           m.ts AS message_ts,
           1 - (c.embedding <=> ${literal}::vector) AS sim
    FROM message_chunks c
    JOIN messages m ON m.id = c.message_id
    WHERE m.user_id = ${user_id}
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
  return rows.filter((r) => r.sim > 0.5);
}
