import { createHash } from 'node:crypto';
import { asc, desc, sql } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from './db/index.js';
import { audit_log } from './db/schema.js';
import { logger } from './logger.js';

const ADVISORY_LOCK_ID = 928374651;

function stableJsonify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJsonify(obj[k])}`)
    .join(',')}}`;
}

export function chainHash(
  parentHash: string | null,
  ts: Date,
  actor: string,
  action: string,
  payload: unknown,
): string {
  const input = `${parentHash ?? ''}|${ts.toISOString()}|${actor}|${action}|${stableJsonify(payload)}`;
  return createHash('sha256').update(input).digest('hex');
}

export interface AuditEntry {
  id: string;
  ts: Date;
  actor: string;
  action: string;
  payload: unknown;
  parent_hash: string | null;
  self_hash: string;
}

export async function logAudit(opts: {
  actor: 'agent' | 'user';
  action: string;
  payload: unknown;
}): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      // Serialize chain writes via PG advisory lock (released at tx end).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
      const last = await tx
        .select({ self_hash: audit_log.self_hash })
        .from(audit_log)
        .orderBy(desc(audit_log.ts))
        .limit(1);
      const parentHash = last[0]?.self_hash ?? null;
      const ts = new Date();
      const selfHash = chainHash(parentHash, ts, opts.actor, opts.action, opts.payload);
      await tx.insert(audit_log).values({
        ts,
        actor: opts.actor,
        action: opts.action,
        payload: opts.payload as object,
        parent_hash: parentHash,
        self_hash: selfHash,
      });
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, action: opts.action }, 'audit_log_failed');
  }
}

export async function getAuditChainForTurn(turn_id: string): Promise<AuditEntry[]> {
  if (!isMemoryEnabled()) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(audit_log)
    .where(sql`payload->>'turn_id' = ${turn_id}`)
    .orderBy(asc(audit_log.ts));
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    payload: r.payload,
    parent_hash: r.parent_hash,
    self_hash: r.self_hash,
  }));
}

export interface ChainVerifyResult {
  ok: boolean;
  rows_checked: number;
  broken_at?: string;
}

export async function verifyChain(): Promise<ChainVerifyResult> {
  if (!isMemoryEnabled()) return { ok: true, rows_checked: 0 };
  const db = getDb();
  const all = await db.select().from(audit_log).orderBy(asc(audit_log.ts));
  let prev: string | null = null;
  for (const row of all) {
    if (row.parent_hash !== prev) {
      return { ok: false, rows_checked: all.length, broken_at: row.id };
    }
    const expected = chainHash(prev, row.ts, row.actor, row.action, row.payload);
    if (expected !== row.self_hash) {
      return { ok: false, rows_checked: all.length, broken_at: row.id };
    }
    prev = row.self_hash;
  }
  return { ok: true, rows_checked: all.length };
}
