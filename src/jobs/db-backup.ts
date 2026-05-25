import { gzipSync } from 'node:zlib';
import { getRawClient, isMemoryEnabled } from '../db/index.js';
import { logger } from '../logger.js';
import { isStorageEnabled, storeBlob } from '../storage/s3.js';
import { alertOps } from '../alerts.js';

const BACKUP_BUCKET = 'pg-backups';
const TABLES = [
  'messages',
  'message_chunks',
  'thread_summary',
  'user_profile',
  'audit_log',
  'facts',
  'turn_state',
  'trajectories',
  'eval_set',
  'eval_runs',
  'skills',
  'cron_jobs',
  'scraped_pages',
];

/**
 * Logical backup: dump each table as JSONL → single gzip blob → S3.
 * Not a true pg_dump (no DDL), but sufficient for restore via INSERT replay.
 */
export async function runDailyBackup(): Promise<void> {
  if (!isMemoryEnabled()) {
    logger.info('db_backup: DB not configured, skipping');
    return;
  }
  if (!isStorageEnabled()) {
    logger.warn('db_backup: storage not configured, skipping');
    return;
  }

  const sql = getRawClient();
  const dateStr = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  let totalRows = 0;

  for (const table of TABLES) {
    try {
      const rows = await sql<Record<string, unknown>[]>`SELECT * FROM ${sql(table)}`;
      lines.push(`-- TABLE ${table}: ${rows.length} rows`);
      for (const row of rows) {
        lines.push(JSON.stringify({ table, row }));
      }
      totalRows += rows.length;
    } catch (err) {
      logger.warn({ err: (err as Error).message, table }, 'db_backup_table_failed');
    }
  }

  if (totalRows === 0) {
    logger.info('db_backup: 0 rows, skipping upload');
    return;
  }

  const jsonl = lines.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(jsonl, 'utf-8'));
  const key = `${dateStr}.jsonl.gz`;

  try {
    await storeBlob(BACKUP_BUCKET, key, gz, 'application/gzip');
    logger.info(
      { key, rows: totalRows, bytes: gz.length },
      'db_backup_done',
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'db_backup_upload_failed');
    await alertOps(`🚨 db_backup upload failed: ${(err as Error).message}`);
  }
}
