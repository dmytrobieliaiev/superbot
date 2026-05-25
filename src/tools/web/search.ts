import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 15_000;

interface SearchArgs {
  query: string;
  depth?: 'basic' | 'advanced';
  max_results?: number;
}

interface TavilyResult {
  url: string;
  title: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
  query?: string;
}

function formatResults(r: TavilyResponse): string {
  const parts: string[] = [];
  if (r.answer) parts.push(`Answer: ${r.answer}`);
  for (const [i, item] of (r.results ?? []).entries()) {
    parts.push(
      `[${i + 1}] ${item.title}\n${item.url}\n${item.content.slice(0, 500)}`,
    );
  }
  return parts.join('\n\n');
}

export const web_search: ToolSpec<SearchArgs> = {
  name: 'web_search',
  description:
    'Search the web with Tavily. Returns an LLM-friendly answer + ranked sources with snippets.',
  params_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      depth: {
        type: 'string',
        enum: ['basic', 'advanced'],
        default: 'basic',
        description: 'Advanced uses more credits + deeper crawl.',
      },
      max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  cost_estimate: (a) => (a.depth === 'advanced' ? 0.005 : 0.001),
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.TAVILY_API_KEY) {
      return {
        status: 'error',
        content: 'TAVILY_API_KEY not configured',
        error: 'no_api_key',
        meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
      };
    }
    const body = {
      api_key: env.TAVILY_API_KEY,
      query: args.query,
      search_depth: args.depth ?? 'basic',
      max_results: args.max_results ?? 5,
      include_answer: true,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        return {
          status: 'error',
          content: `Tavily HTTP ${resp.status}`,
          error: `http_${resp.status}`,
          meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
        };
      }
      const data = (await resp.json()) as TavilyResponse;
      return {
        status: 'ok',
        content: formatResults(data),
        meta: {
          latency_ms: Date.now() - started,
          cost_usd: args.depth === 'advanced' ? 0.005 : 0.001,
          cache_hit: false,
        },
      };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, query: args.query },
        'web_search failed',
      );
      return {
        status: 'error',
        content: `web_search error: ${(err as Error).message}`,
        error: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
