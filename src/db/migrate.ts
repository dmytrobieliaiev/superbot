import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = 'migrations';

const OUR_TABLES = [
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

interface AppliedRow {
  name: string;
}

interface TableRow {
  table_name: string;
}

export async function runMigrations(): Promise<void> {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set');
  }
  const client = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await client`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (await client<AppliedRow[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );

    // Data-loss canary: our tables exist but no migration record → suspicious
    const existing = await client<TableRow[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${OUR_TABLES})
    `;
    if (existing.length > 0 && applied.size === 0) {
      logger.error(
        { tables: existing.map((e) => e.table_name) },
        'DATA_LOSS_CANARY: our tables exist but no migration recorded — refusing to run',
      );
      throw new Error('Migration init from non-empty database — manual review required');
    }

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      logger.info({ file }, 'applying migration');
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf-8');
      await client.unsafe(sql);
      await client`INSERT INTO schema_migrations (name) VALUES (${file})`;
      logger.info({ file }, 'migration applied');
    }
    logger.info({ applied_count: files.length - applied.size }, 'migrations done');
  } finally {
    await client.end();
  }
}

// Allow `pnpm tsx src/db/migrate.ts` for one-shot invocation
const entry = process.argv[1];
if (entry && import.meta.url === `file://${entry}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      // Dump full error — postgres errors hide info on .code/.detail/.position
      // and sometimes have empty .message
      const e = err as {
        message?: string;
        code?: string;
        severity?: string;
        detail?: string;
        hint?: string;
        position?: string;
        where?: string;
        schema_name?: string;
        table_name?: string;
        column_name?: string;
        constraint_name?: string;
        file?: string;
        line?: string;
        routine?: string;
        stack?: string;
        cause?: unknown;
      };
      logger.fatal(
        {
          message: e?.message ?? '(empty)',
          code: e?.code,
          severity: e?.severity,
          detail: e?.detail,
          hint: e?.hint,
          position: e?.position,
          where: e?.where,
          schema: e?.schema_name,
          table: e?.table_name,
          column: e?.column_name,
          constraint: e?.constraint_name,
          pg_file: e?.file,
          pg_line: e?.line,
          routine: e?.routine,
          cause: e?.cause,
          stack: e?.stack,
          raw: JSON.stringify(
            err,
            Object.getOwnPropertyNames(err as object).filter((k) => k !== 'stack'),
          ),
        },
        'migration failed',
      );
      process.exit(1);
    });
}

// quiet eslint about unused import
void fileURLToPath;
