import { createHash } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { heartbeats } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueTurn } from '../queue/turns.js';
import { slackClient } from '../slack/client.js';
import type { EnrichedEvent } from '../slack/types.js';

const POLL_INTERVAL_MS = 5 * 60_000;
const BATCH = 20;
let timer: NodeJS.Timeout | null = null;

function cadenceMs(cadence: string): number {
  switch (cadence) {
    case 'hourly':
      return 60 * 60_000;
    case 'daily':
      return 24 * 60 * 60_000;
    case 'weekly':
      return 7 * 24 * 60 * 60_000;
    default:
      return 24 * 60 * 60_000;
  }
}

async function getOrOpenDm(userId: string, existing?: string | null): Promise<string | null> {
  if (existing) return existing;
  try {
    const r = await slackClient().conversations.open({ users: userId });
    return r.channel?.id ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId }, 'heartbeat_dm_open_failed');
    return null;
  }
}

export function startHeartbeatRunner(queue: Queue<EnrichedEvent>): void {
  if (timer) return;
  if (!isMemoryEnabled()) {
    logger.info('heartbeat_runner: DB not configured; not starting');
    return;
  }
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'heartbeat_runner_started');

  const tick = (): void => {
    void runOnce(queue).catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'heartbeat_runner_failed');
    });
    timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopHeartbeatRunner(): void {
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
    .from(heartbeats)
    .where(and(eq(heartbeats.enabled, true), lte(heartbeats.next_run_at, now)))
    .limit(BATCH);

  for (const hb of due) {
    const channelId = await getOrOpenDm(hb.user_id, hb.dm_channel_id);
    if (!channelId) continue;
    if (!hb.dm_channel_id) {
      await db.update(heartbeats).set({ dm_channel_id: channelId }).where(eq(heartbeats.id, hb.id));
    }

    const evt: EnrichedEvent = {
      event_id: `hb-${hb.id}-${Date.now()}`,
      ts: String(Math.floor(Date.now() / 1000)),
      channel_id: channelId,
      channel_type: 'im',
      user_id: hb.user_id,
      text: `[heartbeat scan] ${hb.scan_prompt}\n\nIf you find something actionable, propose it via routine_propose. Otherwise, send a brief summary or stay silent.`,
      files: [],
      mentions: [],
      kind: 'dm',
    };

    try {
      await enqueueTurn(queue, evt);
      const next = new Date(now.getTime() + cadenceMs(hb.cadence));
      await db
        .update(heartbeats)
        .set({ last_run_at: now, next_run_at: next })
        .where(eq(heartbeats.id, hb.id));
      logger.info({ hb_id: hb.id, user: hb.user_id, cadence: hb.cadence }, 'heartbeat_fired');
    } catch (err) {
      logger.warn({ err: (err as Error).message, hb_id: hb.id }, 'heartbeat_dispatch_failed');
    }
  }
}

export function toolSetHash(toolNames: string[]): string {
  const h = createHash('sha256');
  h.update([...toolNames].sort().join('|'));
  return h.digest('hex').slice(0, 16);
}
