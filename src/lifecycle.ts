import { logger } from './logger.js';

const pending = new Set<Promise<unknown>>();

/**
 * Track an in-flight async operation so graceful shutdown can wait for it.
 * Use for fire-and-forget memory writes, fact extraction, summarizer triggers.
 */
export function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

export async function flushPending(timeoutMs = 30_000): Promise<void> {
  if (pending.size === 0) return;
  logger.info({ pending: pending.size, timeout_ms: timeoutMs }, 'flushing pending async work');
  const wait = Promise.allSettled([...pending]).then(() => undefined);
  const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([wait, timer]);
  if (pending.size > 0) {
    logger.warn({ remaining: pending.size }, 'flush timeout — abandoning remaining work');
  }
}
