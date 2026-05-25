import { and, eq, isNull, lte } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { cron_jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueTurn } from '../queue/turns.js';
import type { EnrichedEvent } from '../slack/types.js';

const POLL_INTERVAL_MS = 60_000; // every minute
const BATCH = 10;

let timer: NodeJS.Timeout | null = null;

export function startSchedulerRunner(queue: Queue<EnrichedEvent>): void {
  if (timer) return;
  if (!isMemoryEnabled()) {
    logger.info('scheduler_runner: DB not configured; not starting');
    return;
  }
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'scheduler_runner_started');

  const tick = (): void => {
    void runOnce(queue).catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'scheduler_runner_failed');
    });
    timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopSchedulerRunner(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function runOnce(queue: Queue<EnrichedEvent>): Promise<void> {
  const db = getDb();
  const now = new Date();
  const due = await db
    .select()
    .from(cron_jobs)
    .where(
      and(
        eq(cron_jobs.active, true),
        isNull(cron_jobs.fired_at),
        lte(cron_jobs.fire_at, now),
      ),
    )
    .limit(BATCH);

  for (const job of due) {
    const evt: EnrichedEvent = {
      event_id: `cron-${job.id}`,
      ts: String(Math.floor(Date.now() / 1000)),
      channel_id: job.owner_channel_id,
      channel_type: 'channel',
      user_id: job.owner_user_id,
      text: job.action_prompt,
      files: [],
      mentions: [],
      kind: 'mention',
    };
    try {
      await enqueueTurn(queue, evt);
      await db
        .update(cron_jobs)
        .set({ fired_at: new Date(), active: false })
        .where(eq(cron_jobs.id, job.id));
      logger.info({ job_id: job.id, fire_at: job.fire_at }, 'scheduled_job_fired');
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, job_id: job.id },
        'scheduled_job_dispatch_failed',
      );
    }
  }
}
