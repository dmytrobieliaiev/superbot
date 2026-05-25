import { env } from './config/env.js';
import { logger } from './logger.js';
import { slackClient } from './slack/client.js';

export async function alertOps(text: string): Promise<void> {
  if (!env.AGENT_OPS_CHANNEL) return;
  try {
    await slackClient().chat.postMessage({
      channel: env.AGENT_OPS_CHANNEL,
      text,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'alert_post_failed');
  }
}
