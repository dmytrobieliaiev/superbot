import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import type { EnrichedEvent, EventKind } from '../slack/types.js';

export const TURNS_QUEUE = 'turns';

export type Priority = 'high' | 'med' | 'low';

const PRIORITY_VALUE: Record<Priority, number> = {
  high: 1,
  med: 5,
  low: 10,
};

export function priorityForKind(kind: EventKind): Priority {
  if (kind === 'dm' || kind === 'command' || kind === 'shortcut' || kind === 'interactive') {
    return 'high';
  }
  if (kind === 'mention') return 'med';
  return 'low';
}

export function createTurnsQueue(redis: Redis): Queue<EnrichedEvent> {
  return new Queue<EnrichedEvent>(TURNS_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
      removeOnFail: { count: 5000 },
    },
  });
}

export async function enqueueTurn(
  queue: Queue<EnrichedEvent>,
  evt: EnrichedEvent,
): Promise<void> {
  const priority = PRIORITY_VALUE[priorityForKind(evt.kind)];
  await queue.add('turn', evt, {
    priority,
    jobId: evt.event_id, // queue-level idempotency for Slack retries
  });
  logger.debug({ event_id: evt.event_id, kind: evt.kind, priority }, 'turn enqueued');
}

export type TurnJobHandler = (
  job: Job<EnrichedEvent>,
  token?: string,
) => Promise<void>;

export function createTurnsWorker(
  redis: Redis,
  handler: TurnJobHandler,
  concurrency = 5,
): Worker<EnrichedEvent> {
  const worker = new Worker<EnrichedEvent>(
    TURNS_QUEUE,
    async (job, token) => {
      await handler(job, token);
    },
    { connection: redis, concurrency },
  );
  worker.on('failed', (job, err) => {
    logger.error({ err: err.message, job_id: job?.id }, 'turn job failed');
  });
  worker.on('completed', (job) => {
    logger.debug({ job_id: job.id }, 'turn job completed');
  });
  return worker;
}
