import postgres from 'postgres';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

const MAX_ROWS = 1000;
const DEFAULT_ROW_LIMIT = 100;
const TIMEOUT_MS = 30_000;

const SELECT_REGEX = /^\s*(SELECT|EXPLAIN|WITH)\b/i;
const FORBIDDEN_REGEX =
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|LOCK|VACUUM|REINDEX|CLUSTER)\b/i;

interface QueryArgs {
  sql: string;
  row_limit?: number;
}

let _client: ReturnType<typeof postgres> | null = null;

function client(): ReturnType<typeof postgres> {
  if (_client) return _client;
  const url = env.ANALYTICS_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) throw new Error('ANALYTICS_DATABASE_URL not set');
  _client = postgres(url, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 5,
  });
  return _client;
}

export const db_query: ToolSpec<QueryArgs> = {
  name: 'db_query',
  description:
    'Run a read-only SQL query against the analytics database. SELECT/EXPLAIN/WITH only. Returns rows as JSON.',
  params_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'SELECT/EXPLAIN/WITH statement only' },
      row_limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_ROWS,
        default: DEFAULT_ROW_LIMIT,
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();

    if (!SELECT_REGEX.test(args.sql)) {
      return errorResult('only SELECT/EXPLAIN/WITH allowed', 'sql_forbidden', started);
    }
    if (FORBIDDEN_REGEX.test(args.sql)) {
      return errorResult('SQL contains forbidden write keyword', 'sql_forbidden', started);
    }

    const rowLimit = Math.min(args.row_limit ?? DEFAULT_ROW_LIMIT, MAX_ROWS);

    try {
      const sql = client();
      const queryPromise = sql.unsafe(`${args.sql.replace(/;\s*$/, '')} LIMIT ${rowLimit}`);
      const rows = (await Promise.race([
        queryPromise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('query_timeout')), TIMEOUT_MS),
        ),
      ])) as Record<string, unknown>[];

      const content =
        rows.length === 0
          ? '(0 rows)'
          : `${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`;

      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'db_query failed');
      return errorResult(
        `db_query error: ${(err as Error).message}`,
        (err as Error).message,
        started,
      );
    }
  },
};

function errorResult(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
