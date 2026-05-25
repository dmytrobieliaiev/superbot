import type { Redis } from 'ioredis';

// Default safety TTL — locks auto-release after this if process dies mid-turn.
const DEFAULT_TTL_SEC = 300;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export async function acquireLock(
  redis: Redis,
  key: string,
  holder: string,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<boolean> {
  const result = await redis.set(key, holder, 'EX', ttlSec, 'NX');
  return result === 'OK';
}

/** Releases only if we still hold the lock (avoids stomping another holder). */
export async function releaseLock(redis: Redis, key: string, holder: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, holder);
}
