import type { Config } from 'drizzle-kit';
import 'dotenv/config';

// Drizzle Kit config — used for `drizzle-kit generate` to diff schema → SQL.
// Live migrations are run by src/db/migrate.ts (not via drizzle-kit push).

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/placeholder',
  },
  verbose: true,
  strict: true,
} satisfies Config;
