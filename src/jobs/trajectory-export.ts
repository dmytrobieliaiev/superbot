import { gzipSync } from 'node:zlib';
import { and, gte, isNull, lte } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { trajectories } from '../db/schema.js';
import { logger } from '../logger.js';
import { isStorageEnabled, storeBlob } from '../storage/s3.js';

const TRAJ_BUCKET = 'traj';

export interface ExportResult {
  count: number;
  bytes: number;
  key?: string;
  skipped_reason?: string;
}

export async function exportYesterday(): Promise<ExportResult> {
  if (!isMemoryEnabled()) return { count: 0, bytes: 0, skipped_reason: 'no_db' };
  if (!isStorageEnabled()) return { count: 0, bytes: 0, skipped_reason: 'no_storage' };

  const db = getDb();
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const rows = await db
    .select()
    .from(trajectories)
    .where(
      and(
        gte(trajectories.created_at, dayStart),
        lte(trajectories.created_at, dayEnd),
        isNull(trajectories.exported_at),
      ),
    );

  if (rows.length === 0) return { count: 0, bytes: 0, skipped_reason: 'no_rows' };

  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const gz = gzipSync(Buffer.from(jsonl, 'utf-8'));
  const dateStr = dayStart.toISOString().slice(0, 10);
  const key = `${dateStr}.jsonl.gz`;

  await storeBlob(TRAJ_BUCKET, key, gz, 'application/gzip');

  // Mark rows as exported
  const now2 = new Date();
  await db
    .update(trajectories)
    .set({ exported_at: now2 })
    .where(
      and(
        gte(trajectories.created_at, dayStart),
        lte(trajectories.created_at, dayEnd),
        isNull(trajectories.exported_at),
      ),
    );

  logger.info(
    { key, count: rows.length, bytes: gz.length, date: dateStr },
    'trajectory_export_done',
  );
  return { count: rows.length, bytes: gz.length, key };
}
