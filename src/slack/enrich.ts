import type { WebClient } from '@slack/web-api';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import type {
  ChannelInfo,
  EnrichedEvent,
  InboundEvent,
  ThreadMessage,
  UserInfo,
} from './types.js';

const CACHE_TTL_SEC = 15 * 60;

async function cachedFetch<T>(
  redis: Redis,
  key: string,
  fetcher: () => Promise<T>,
): Promise<T | undefined> {
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // fall through and refetch
    }
  }
  try {
    const value = await fetcher();
    await redis.setex(key, CACHE_TTL_SEC, JSON.stringify(value));
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'enrich fetch failed');
    return undefined;
  }
}

export async function enrich(
  client: WebClient,
  evt: InboundEvent,
  redis: Redis,
): Promise<EnrichedEvent> {
  const result: EnrichedEvent = { ...evt };

  const userPromise = cachedFetch<UserInfo>(redis, `users:${evt.user_id}`, async () => {
    const r = await client.users.info({ user: evt.user_id });
    const info: UserInfo = {};
    if (r.user?.real_name ?? r.user?.name) info.name = r.user?.real_name ?? r.user?.name;
    if (r.user?.tz) info.tz = r.user.tz;
    info.is_bot = r.user?.is_bot ?? false;
    return info;
  });

  const channelPromise = cachedFetch<ChannelInfo>(
    redis,
    `chan:${evt.channel_id}`,
    async () => {
      const r = await client.conversations.info({ channel: evt.channel_id });
      const info: ChannelInfo = {};
      if (r.channel?.name) info.name = r.channel.name;
      if (r.channel?.topic?.value) info.topic = r.channel.topic.value;
      if (typeof r.channel?.is_private === 'boolean') info.is_private = r.channel.is_private;
      return info;
    },
  );

  const threadTs = evt.thread_ts;
  const threadPromise = threadTs
    ? (async (): Promise<ThreadMessage[] | undefined> => {
        try {
          const r = await client.conversations.replies({
            channel: evt.channel_id,
            ts: threadTs,
            limit: 20,
          });
          return (r.messages ?? []).map((m) => ({
            user: m.user ?? 'unknown',
            text: m.text ?? '',
            ts: m.ts ?? '',
          }));
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'thread replies fetch failed');
          return undefined;
        }
      })()
    : Promise.resolve(undefined);

  const [userInfo, channelInfo, threadBacklog] = await Promise.all([
    userPromise,
    channelPromise,
    threadPromise,
  ]);

  if (userInfo) result.user_info = userInfo;
  if (channelInfo) result.channel_info = channelInfo;
  if (threadBacklog) result.thread_backlog = threadBacklog;

  return result;
}
