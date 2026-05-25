import type { Redis } from 'ioredis';

const DEDUP_TTL_SEC = 24 * 60 * 60;

/**
 * SETNX-based event dedupe. Returns true if event is new, false if already seen.
 * Slack retries on slow ack — this ensures we process each event once.
 */
export async function markEventSeen(redis: Redis, eventId: string): Promise<boolean> {
  const key = `evt:${eventId}`;
  const result = await redis.set(key, '1', 'EX', DEDUP_TTL_SEC, 'NX');
  return result === 'OK';
}
