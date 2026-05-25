import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { stableStringify } from './util/stable-stringify.js';
import type { ToolResult } from './types.js';

const DEFAULT_TTL_SEC = 24 * 60 * 60;

function cacheKey(toolName: string, args: unknown): string {
  const canonical = stableStringify(args);
  const hash = createHash('sha256').update(`${toolName}|${canonical}`).digest('hex');
  return `tool:${toolName}:${hash}`;
}

export async function getCachedToolResult(
  redis: Redis,
  toolName: string,
  args: unknown,
): Promise<ToolResult | null> {
  const key = cacheKey(toolName, args);
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ToolResult;
    parsed.meta.cache_hit = true;
    return parsed;
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'tool cache read failed');
    return null;
  }
}

export async function setCachedToolResult(
  redis: Redis,
  toolName: string,
  args: unknown,
  result: ToolResult,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<void> {
  if (result.status !== 'ok') return; // only cache successful results
  const key = cacheKey(toolName, args);
  try {
    await redis.setex(key, ttlSec, JSON.stringify(result));
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'tool cache write failed');
  }
}
