import { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';

let cached: WebClient | undefined;

export function slackClient(): WebClient {
  if (cached) return cached;
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not set');
  }
  cached = new WebClient(env.SLACK_BOT_TOKEN);
  return cached;
}
