import { sql } from 'drizzle-orm';
import { getRawClient, isMemoryEnabled } from '../db/index.js';
import { decayConfidence } from '../memory/facts.js';
import { logger } from '../logger.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SCRAPED_PAGES_TTL_DAYS = 30;

let timer: NodeJS.Timeout | null = null;

async function pruneScrapedPages(): Promise<{ pruned: number }> {
  if (!isMemoryEnabled()) return { pruned: 0 };
  const sqlClient = getRawClient();
  const rows = await sqlClient<{ count: number }[]>`
    WITH del AS (
      DELETE FROM scraped_pages
      WHERE fetched_at < now() - (${SCRAPED_PAGES_TTL_DAYS}::int * interval '1 day')
      RETURNING url_hash
    )
    SELECT count(*)::int AS count FROM del
  `;
  return { pruned: rows[0]?.count ?? 0 };
}

export function startDecayJob(): void {
  if (timer) return;
  logger.info({ interval_ms: ONE_DAY_MS }, 'decay job scheduled (daily)');

  const initialDelay = 60 * 1000; // 1min after boot
  timer = setTimeout(function tick() {
    void (async () => {
      try {
        const factR = await decayConfidence();
        if (factR.decayed > 0 || factR.soft_deleted > 0) {
          logger.info(factR, 'fact_decay_run');
        }
        const pageR = await pruneScrapedPages();
        if (pageR.pruned > 0) {
          logger.info(pageR, 'scraped_pages_prune');
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'decay_job_failed');
      } finally {
        timer = setTimeout(tick, ONE_DAY_MS);
      }
    })();
  }, initialDelay);
}

// quiet unused import warning during build before scraper used inside file
void sql;

export function stopDecayJob(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
