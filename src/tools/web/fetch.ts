import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { isSafeUrl } from '../util/safe-url.js';
import type { ToolResult, ToolSpec } from '../types.js';

const JINA_PREFIX = 'https://r.jina.ai/';
const TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CHARS = 30_000;

interface FetchArgs {
  url: string;
  max_chars?: number;
}

export const web_fetch: ToolSpec<FetchArgs> = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return clean markdown via Jina Reader. Use for specific known URLs (docs, articles).',
  params_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'Absolute http(s) URL' },
      max_chars: {
        type: 'integer',
        minimum: 100,
        maximum: 100000,
        default: DEFAULT_MAX_CHARS,
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isSafeUrl(args.url)) {
      return {
        status: 'error',
        content: 'URL blocked by safety check (loopback / internal / non-http)',
        error: 'unsafe_url',
        meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
      };
    }
    const full = JINA_PREFIX + args.url;
    const headers: Record<string, string> = { Accept: 'text/markdown' };
    if (env.JINA_API_KEY) headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(full, { headers, signal: controller.signal });
      if (!resp.ok) {
        return {
          status: 'error',
          content: `Jina HTTP ${resp.status}`,
          error: `http_${resp.status}`,
          meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
        };
      }
      const text = await resp.text();
      const max = args.max_chars ?? DEFAULT_MAX_CHARS;
      const truncated = text.length > max;
      const content = truncated ? text.slice(0, max) + '\n\n…[truncated]' : text;
      return {
        status: 'ok',
        content,
        meta: {
          latency_ms: Date.now() - started,
          cost_usd: 0,
          cache_hit: false,
          truncated,
        },
      };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, url: args.url },
        'web_fetch failed',
      );
      return {
        status: 'error',
        content: `web_fetch error: ${(err as Error).message}`,
        error: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
