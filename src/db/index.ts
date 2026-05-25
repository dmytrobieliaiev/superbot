import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Sql = ReturnType<typeof postgres>;

let _client: Sql | null = null;
let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  _client = postgres(env.DATABASE_URL, { max: 10 });
  _db = drizzle(_client, { schema });
  return _db;
}

/** Raw postgres-js client. Use for vector ANN queries that need <=> operator. */
export function getRawClient(): Sql {
  if (!_client) getDb();
  return _client!;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export function isMemoryEnabled(): boolean {
  return !!env.DATABASE_URL;
}
