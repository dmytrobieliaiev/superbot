import { and, eq, lte, or, isNull } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { routines } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueTurn } from '../queue/turns.js';
import { listAll } from '../tools/registry.js';
import type { EnrichedEvent } from '../slack/types.js';
import { nextCronFire } from './cron-parse.js';
import { toolSetHash } from './heartbeat.js';

const POLL_INTERVAL_MS = 60_000;
const BATCH = 20;
const MAX_CONSECUTIVE_FAILURES = 3;
let timer: NodeJS.Timeout | null = null;

export function startRoutineRunner(queue: Queue<EnrichedEvent>): void {
  if (timer) return;
  if (!isMemoryEnabled()) {
    logger.info('routine_runner: DB not configured; not starting');
    return;
  }
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'routine_runner_started');

  const tick = (): void => {
    void runOnce(queue).catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'routine_runner_failed');
    });
    timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopRoutineRunner(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function runOnce(queue: Queue<EnrichedEvent>): Promise<void> {
  const db = getDb();
  const now = new Date();

  const currentHash = toolSetHash(listAll().map((t) => t.name));

  const due = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.status, 'approved'),
        eq(routines.trigger_kind, 'cron'),
        or(isNull(routines.next_run_at), lte(routines.next_run_at, now)),
      ),
    )
    .limit(BATCH);

  for (const r of due) {
    // Tool-set drift check: if tool registry changed since approval, pause until re-approved.
    if (r.tool_set_hash !== currentHash) {
      await db
        .update(routines)
        .set({ status: 'pending', last_run_status: 'tool_drift' })
        .where(eq(routines.id, r.id));
      logger.warn({ routine_id: r.id, was: r.tool_set_hash, now: currentHash }, 'routine_tool_drift_paused');
      continue;
    }

    const evt: EnrichedEvent = {
      event_id: `routine-${r.id}-${Date.now()}`,
      ts: String(Math.floor(Date.now() / 1000)),
      channel_id: r.channel_id,
      channel_type: 'channel',
      user_id: r.user_id,
      text: `[routine "${r.name}"] ${r.plan_prompt}`,
      files: [],
      mentions: [],
      kind: 'mention',
    };

    try {
      await enqueueTurn(queue, evt);
      const spec = r.trigger_spec as { cron?: string };
      let next: Date | null = null;
      if (spec?.cron) {
        try {
          next = nextCronFire(spec.cron, now);
        } catch (err) {
          logger.warn({ err: (err as Error).message, routine_id: r.id }, 'routine_cron_parse_failed');
        }
      }
      await db
        .update(routines)
        .set({
          last_run_at: now,
          last_run_status: 'dispatched',
          next_run_at: next,
          consecutive_failures: 0,
        })
        .where(eq(routines.id, r.id));
      logger.info({ routine_id: r.id, next }, 'routine_fired');
    } catch (err) {
      const failures = (r.consecutive_failures ?? 0) + 1;
      const update: Partial<typeof routines.$inferInsert> = {
        last_run_at: now,
        last_run_status: 'error',
        consecutive_failures: failures,
      };
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        update.status = 'paused';
      }
      await db.update(routines).set(update).where(eq(routines.id, r.id));
      logger.warn(
        { err: (err as Error).message, routine_id: r.id, failures },
        'routine_dispatch_failed',
      );
    }
  }
}
