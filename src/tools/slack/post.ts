import { checkToolAcl } from '../../config/tool-acl.js';
import { logger } from '../../logger.js';
import { slackClient } from '../../slack/client.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface PostArgs {
  channel?: string;
  user?: string;
  text: string;
  thread_ts?: string;
}

async function openDm(userId: string): Promise<string> {
  const r = await slackClient().conversations.open({ users: userId });
  const id = r.channel?.id;
  if (!id) throw new Error('conversations.open returned no channel id');
  return id;
}

export const slack_post: ToolSpec<PostArgs> = {
  name: 'slack_post',
  description:
    'Post a message to a Slack channel OR direct-message a user. Pass `channel` (C…) for channels, or `user` (U…) to open/reuse a DM. Both gated by allowlist.',
  params_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID (C…) — must be in slack_post allowlist' },
      user: { type: 'string', description: 'User ID (U…) — must be in slack_dm allowlist. Opens DM via conversations.open.' },
      text: { type: 'string', description: 'Message text, Slack markdown supported' },
      thread_ts: { type: 'string', description: 'Optional thread parent ts (channel post only)' },
    },
    required: ['text'],
    additionalProperties: false,
    oneOf: [{ required: ['channel'] }, { required: ['user'] }],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!args.channel && !args.user) {
      return {
        status: 'error',
        content: 'slack_post: must provide `channel` or `user`',
        error: 'bad_args',
        meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
      };
    }
    if (args.channel && args.user) {
      return {
        status: 'error',
        content: 'slack_post: provide `channel` OR `user`, not both',
        error: 'bad_args',
        meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
      };
    }

    let targetChannel: string;
    let label: string;

    if (args.user) {
      if (!checkToolAcl('slack_dm_targets', '*', args.user)) {
        return {
          status: 'error',
          content: `slack_post: target user ${args.user} not in slack_dm_targets allowlist`,
          error: 'acl_target_user',
          meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
        };
      }
      try {
        targetChannel = await openDm(args.user);
      } catch (err) {
        logger.warn({ err: (err as Error).message, user: args.user }, 'slack_dm_open_failed');
        return {
          status: 'error',
          content: `slack_post: conversations.open failed: ${(err as Error).message}`,
          error: 'dm_open_failed',
          meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
        };
      }
      label = `DM ${args.user} (${targetChannel})`;
    } else {
      targetChannel = args.channel!;
      if (!checkToolAcl('slack_post_targets', targetChannel, '*')) {
        return {
          status: 'error',
          content: `slack_post: target channel ${targetChannel} not in slack_post_targets allowlist`,
          error: 'acl_target_channel',
          meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
        };
      }
      label = targetChannel;
    }

    try {
      const params: Parameters<ReturnType<typeof slackClient>['chat']['postMessage']>[0] = {
        channel: targetChannel,
        text: args.text,
      };
      if (args.thread_ts && !args.user) params.thread_ts = args.thread_ts;
      const r = await slackClient().chat.postMessage(params);
      return {
        status: 'ok',
        content: `posted to ${label} (ts=${r.ts ?? '?'})`,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, target: targetChannel }, 'slack_post failed');
      return {
        status: 'error',
        content: `slack_post error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
