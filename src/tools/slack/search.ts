import { logger } from '../../logger.js';
import { slackClient } from '../../slack/client.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface SearchArgs {
  query: string;
  count?: number;
}

interface MatchLite {
  permalink?: string;
  channel?: { name?: string };
  username?: string;
  user?: string;
  text?: string;
  ts?: string;
}

export const slack_search: ToolSpec<SearchArgs> = {
  name: 'slack_search',
  description:
    'Search messages across the Slack workspace history. Supports operators like in:#channel, from:@user, after:YYYY-MM-DD.',
  params_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const r = await slackClient().search.messages({
        query: args.query,
        count: args.count ?? 10,
      });
      const matches = (r.messages?.matches ?? []) as MatchLite[];
      const formatted =
        matches.length === 0
          ? 'no matches'
          : matches
              .map((m, i) => {
                const where = m.channel?.name ? `#${m.channel.name}` : '?';
                const who = m.username ?? m.user ?? '?';
                const text = (m.text ?? '').slice(0, 300);
                const link = m.permalink ?? '';
                return `[${i + 1}] ${where} — ${who}\n${text}\n${link}`;
              })
              .join('\n\n');
      return {
        status: 'ok',
        content: formatted,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, query: args.query }, 'slack_search failed');
      return {
        status: 'error',
        content: `slack_search error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
