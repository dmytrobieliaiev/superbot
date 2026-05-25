import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { isSafeUrl } from '../util/safe-url.js';
import type { ToolResult, ToolSpec } from '../types.js';

const FIRECRAWL_URL = 'https://api.firecrawl.dev/v1/scrape';
const TIMEOUT_MS = 90_000;

interface ScraperArgs {
  url: string;
  formats?: Array<'markdown' | 'html' | 'links'>;
  only_main_content?: boolean;
}

export const scraper_api: ToolSpec<ScraperArgs> = {
  name: 'scraper_api',
  description:
    'Scrape an anti-bot / marketplace site via Firecrawl (handles proxy rotation, JS render, anti-bot). Use for sites where web_fetch and browser_render fail.',
  params_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      formats: {
        type: 'array',
        items: { type: 'string', enum: ['markdown', 'html', 'links'] },
        default: ['markdown'],
      },
      only_main_content: { type: 'boolean', default: true },
    },
    required: ['url'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.01,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.FIRECRAWL_API_KEY) {
      return errResult('FIRECRAWL_API_KEY not set', 'no_api_key', started);
    }
    if (!isSafeUrl(args.url)) {
      return errResult('URL blocked by safety check', 'unsafe_url', started);
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(FIRECRAWL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: args.url,
          formats: args.formats ?? ['markdown'],
          onlyMainContent: args.only_main_content ?? true,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return errResult(
          `firecrawl http_${resp.status}: ${text.slice(0, 200)}`,
          `http_${resp.status}`,
          started,
        );
      }
      const data = (await resp.json()) as {
        data?: { markdown?: string; html?: string; links?: string[]; metadata?: { title?: string } };
      };
      const md = data.data?.markdown ?? '';
      const title = data.data?.metadata?.title ?? '';
      const content = title ? `# ${title}\n\n${md}` : md || '(empty)';
      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0.01, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, url: args.url }, 'scraper_api_failed');
      return errResult(
        `scraper_api error: ${(err as Error).message}`,
        (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
        started,
      );
    } finally {
      clearTimeout(t);
    }
  },
};

function errResult(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
