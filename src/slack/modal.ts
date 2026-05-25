import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { slackClient } from './client.js';

const CONFIRM_TTL_SEC = 5 * 60;

export interface PendingConfirm {
  token: string;
  tool_name: string;
  args: unknown;
  user_id: string;
  channel_id: string;
}

export async function postConfirmPrompt(
  redis: Redis,
  channel_id: string,
  tool_name: string,
  args: unknown,
  user_id: string,
): Promise<string> {
  const token = randomUUID();
  const payload: PendingConfirm = { token, tool_name, args, user_id, channel_id };
  await redis.setex(`confirm:${token}`, CONFIRM_TTL_SEC, JSON.stringify(payload));

  try {
    await slackClient().chat.postMessage({
      channel: channel_id,
      text: `⚠️ Confirm destructive action: ${tool_name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *Confirm destructive action*\n\nTool: \`${tool_name}\`\nArgs: \`\`\`${JSON.stringify(args, null, 2).slice(0, 1000)}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Confirm' },
              style: 'primary',
              value: token,
              action_id: 'tool_confirm',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✖️ Cancel' },
              style: 'danger',
              value: token,
              action_id: 'tool_cancel',
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'post_confirm_prompt_failed');
  }
  return token;
}

export async function isConfirmed(redis: Redis, token: string): Promise<boolean> {
  return (await redis.get(`confirm:${token}:ok`)) === '1';
}

export async function markConfirmed(redis: Redis, token: string): Promise<void> {
  await redis.setex(`confirm:${token}:ok`, CONFIRM_TTL_SEC, '1');
}

export async function getPendingConfirm(
  redis: Redis,
  token: string,
): Promise<PendingConfirm | null> {
  const raw = await redis.get(`confirm:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingConfirm;
  } catch {
    return null;
  }
}
