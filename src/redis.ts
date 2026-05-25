import { Redis } from 'ioredis';
import { env } from './config/env.js';
import { logger } from './logger.js';

export function createRedis(): Redis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL not set');
  }
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
  client.once('connect', () => logger.info('redis connected'));
  return client;
}
