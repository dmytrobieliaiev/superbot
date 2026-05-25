import { clampBlocks, type Block } from '../../slack/blocks.js';
import { logger } from '../../logger.js';
import { slackClient } from '../../slack/client.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface BlocksArgs {
  blocks: Block[];
  /** Plain-text fallback shown in notifications. */
  text?: string;
  /** Optional: post to current thread (default) or as a new top-level message. */
  new_message?: boolean;
}

export const slack_blocks: ToolSpec<BlocksArgs> = {
  name: 'slack_blocks',
  description:
    'Post a Block Kit rich message to the current Slack thread. Use for tables, headers, KV fields, buttons, dividers. `blocks` is a Block Kit array (see https://api.slack.com/block-kit). Always include a `text` fallback for notifications.',
  params_schema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'object' },
        description: 'Block Kit blocks array. Supported: section, header, divider, context, actions, image, fields-section.',
      },
      text: { type: 'string', description: 'Notification fallback text (recommended).' },
      new_message: { type: 'boolean', default: false },
    },
    required: ['blocks'],
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const safeBlocks = clampBlocks(args.blocks);
      const fallback = args.text ?? extractFallback(safeBlocks);
      const params: Parameters<ReturnType<typeof slackClient>['chat']['postMessage']>[0] = {
        channel: ctx.channel_id,
        text: fallback,
        blocks: safeBlocks as unknown as never,
      };
      if (!args.new_message && ctx.thread_ts) {
        (params as { thread_ts?: string }).thread_ts = ctx.thread_ts;
      }
      const r = await slackClient().chat.postMessage(params);
      return {
        status: 'ok',
        content: `posted ${safeBlocks.length} block(s) (ts=${r.ts ?? '?'})`,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, blocks: args.blocks?.length }, 'slack_blocks_failed');
      return {
        status: 'error',
        content: `slack_blocks error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};

function extractFallback(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.type === 'header' || b.type === 'section') {
      const t = (b as { text?: { text?: unknown } }).text?.text;
      if (typeof t === 'string') return t.slice(0, 200);
    }
  }
  return 'rich message';
}
