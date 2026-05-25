import type { Queue } from 'bullmq';
import type { EnrichedEvent } from '../slack/types.js';
import { alertOps } from '../alerts.js';
import { logger } from '../logger.js';
import { m_queue_depth } from '../metrics.js';

const POLL_INTERVAL_MS = 60_000;
const ALERT_QUEUE_DEPTH = 50;
const ALERT_BURST_WINDOW_MS = 5 * 60_000;

interface State {
  high_since: number | null;
}

let timer: NodeJS.Timeout | null = null;
const state: State = { high_since: null };

export function startOpsWatchdog(queue: Queue<EnrichedEvent>): void {
  if (timer) return;
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'ops_watchdog_started');
  const tick = (): void => {
    void check(queue).catch((err: unknown) =>
      logger.warn({ err: (err as Error).message }, 'ops_watchdog_failed'),
    );
    timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopOpsWatchdog(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function check(queue: Queue<EnrichedEvent>): Promise<void> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
  const depth = (counts.waiting ?? 0) + (counts.active ?? 0);
  m_queue_depth.set(depth);

  if (depth > ALERT_QUEUE_DEPTH) {
    if (state.high_since === null) {
      state.high_since = Date.now();
    } else if (Date.now() - state.high_since > ALERT_BURST_WINDOW_MS) {
      await alertOps(
        `⚠️ Queue depth high: ${depth} waiting/active for >${ALERT_BURST_WINDOW_MS / 60000}min`,
      );
      state.high_since = Date.now(); // re-arm
    }
  } else {
    state.high_since = null;
  }
}
