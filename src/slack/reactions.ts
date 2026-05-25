import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { critiqueAndRetry } from '../worker/critic-retry.js';
import { slackClient } from './client.js';

export interface ReactionEvent {
  user: string;
  item: { type: string; channel: string; ts: string };
  reaction: string;
  item_user?: string;
}

const POSITIVE = new Set(['thumbsup', '+1', 'heart', 'tada', '100', 'fire', 'star']);
const NEGATIVE = new Set(['thumbsdown', '-1', 'angry', 'pensive', 'cry', 'rage']);
const PIN = new Set(['pushpin', 'bookmark']);
const RETRY = new Set(['arrows_counterclockwise', 'repeat', 'recycle']);

// Bot's own ack reaction for each user reaction
const ACK_REACTION: Record<string, string> = {
  thumbsup: 'white_check_mark',
  '+1': 'white_check_mark',
  thumbsdown: 'pensive',
  '-1': 'pensive',
  pushpin: 'pushpin',
};

type Sentiment = 'positive' | 'negative' | 'pin' | 'retry' | 'neutral';

function classify(reaction: string): Sentiment {
  if (POSITIVE.has(reaction)) return 'positive';
  if (NEGATIVE.has(reaction)) return 'negative';
  if (PIN.has(reaction)) return 'pin';
  if (RETRY.has(reaction)) return 'retry';
  return 'neutral';
}

export async function markThreadActive(redis: Redis, threadTs: string): Promise<void> {
  if (env.THREAD_FOLLOWUP_TTL_SEC <= 0) return;
  try {
    await redis.setex(`thread_active:${threadTs}`, env.THREAD_FOLLOWUP_TTL_SEC, '1');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'mark_thread_active_failed');
  }
}

export async function handleReactionOnBotMessage(
  evt: ReactionEvent,
  botUserId: string,
  redis: Redis,
): Promise<void> {
  if (evt.item.type !== 'message') return;
  if (evt.item_user !== botUserId) return; // not on our message
  if (evt.user === botUserId) return; // ignore bot's own reactions

  const sentiment = classify(evt.reaction);

  logger.info(
    {
      reaction: evt.reaction,
      reactor: evt.user,
      channel: evt.item.channel,
      msg_ts: evt.item.ts,
      sentiment,
    },
    'reaction_on_bot_message',
  );

  await logAudit({
    actor: 'user',
    action: 'reaction_added',
    payload: {
      reaction: evt.reaction,
      reactor: evt.user,
      channel: evt.item.channel,
      msg_ts: evt.item.ts,
      sentiment,
    },
  });

  const client = slackClient();

  // Acknowledge with a reaction back
  const ack = ACK_REACTION[evt.reaction];
  if (ack) {
    await client.reactions
      .add({
        channel: evt.item.channel,
        name: ack,
        timestamp: evt.item.ts,
      })
      .catch((err: unknown) =>
        logger.debug(
          { err: (err as Error).message, reaction: ack },
          'reaction_ack_failed',
        ),
      );
  }

  // Sentiment-specific follow-up
  if (sentiment === 'negative') {
    // Mark thread active so the user's reply continues without re-mentioning
    await markThreadActive(redis, evt.item.ts);

    // Fire critic-retry path async — doesn't block reaction handler
    if (env.CRITIC_ENABLED && env.CRITIC_MODE === 'on_negative') {
      void critiqueAndRetry({
        redis,
        channelId: evt.item.channel,
        botMsgTs: evt.item.ts,
        reactor: evt.user,
        reaction: evt.reaction,
      }).catch((err: unknown) =>
        logger.warn(
          { err: (err as Error).message, msg_ts: evt.item.ts },
          'critic_retry_failed',
        ),
      );
    } else {
      try {
        await client.chat.postMessage({
          channel: evt.item.channel,
          thread_ts: evt.item.ts,
          text: `Sorry that wasn't useful, <@${evt.user}>. Tell me what was off and I'll try again.`,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'reaction_followup_failed');
      }
    }
  }

  if (sentiment === 'retry') {
    try {
      await client.chat.postMessage({
        channel: evt.item.channel,
        thread_ts: evt.item.ts,
        text: `<@${evt.user}> wants another take. Drop the same question in this thread and I'll retry.`,
      });
      await markThreadActive(redis, evt.item.ts);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reaction_retry_failed');
    }
  }

  if (sentiment === 'pin') {
    try {
      await client.chat.postMessage({
        channel: evt.item.channel,
        thread_ts: evt.item.ts,
        text: `📌 Pinned. (To turn this into a durable fact, use \`/remember <text>\`.)`,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reaction_pin_failed');
    }
  }
}
