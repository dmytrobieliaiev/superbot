import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { scraped_pages } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { browser_render } from '../browser/render.js';
import { scraper_api } from '../scraper/index.js';
import { isSafeUrl } from '../util/safe-url.js';
import { web_fetch } from './fetch.js';
import type { ToolContext, ToolResult, ToolSpec } from '../types.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Tier = 'web_fetch' | 'browser_render' | 'scraper_api';

// Marketplace / anti-bot / blocks-JinaReader hosts → start with Firecrawl.
const ANTI_BOT_HOSTS = new Set([
  'autoscout24.de', 'autoscout24.com', 'mobile.de', 'kleinanzeigen.de',
  'amazon.com', 'amazon.de', 'amazon.co.uk',
  'ebay.com', 'ebay.de',
  'facebook.com', 'instagram.com', 'tiktok.com',
  'linkedin.com', 'glassdoor.com', 'indeed.com',
  'craigslist.org', 'olx.pl', 'avito.ru',
  'booking.com', 'airbnb.com',
]);

// JS-heavy SPAs where Jina struggles but Chromium works.
const JS_HEAVY_HOSTS = new Set([
  'twitter.com', 'x.com',
  'reddit.com',
  'discord.com',
  'figma.com',
  'notion.so', 'notion.site',
  'airtable.com',
  'app.asana.com', 'asana.com',
  'linear.app',
]);

interface WebGetArgs {
  url: string;
  force_tool?: Tier;
  bypass_cache?: boolean;
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostMatches(host: string, set: Set<string>): boolean {
  if (set.has(host)) return true;
  for (const d of set) {
    if (host.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function pickTiers(url: string): Tier[] {
  const host = hostOf(url);
  if (hostMatches(host, ANTI_BOT_HOSTS)) {
    return ['scraper_api', 'browser_render', 'web_fetch'];
  }
  if (hostMatches(host, JS_HEAVY_HOSTS)) {
    return ['browser_render', 'scraper_api', 'web_fetch'];
  }
  return ['web_fetch', 'browser_render', 'scraper_api'];
}

async function runTier(
  tier: Tier,
  url: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (tier === 'web_fetch') return web_fetch.execute({ url }, ctx);
  if (tier === 'browser_render') return browser_render.execute({ action: 'content', url }, ctx);
  return scraper_api.execute({ url }, ctx);
}

export const web_get: ToolSpec<WebGetArgs> = {
  name: 'web_get',
  description:
    'Unified URL fetcher. Picks the right backend automatically (static→Jina, JS→Chromium, anti-bot→Firecrawl), falls back on failure, and caches 24h in scraped_pages. PREFER this over web_fetch / browser_render / scraper_api directly unless you need a specific tool.',
  params_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'Absolute http(s) URL' },
      force_tool: {
        type: 'string',
        enum: ['web_fetch', 'browser_render', 'scraper_api'],
        description: 'Override automatic tier selection',
      },
      bypass_cache: { type: 'boolean', default: false },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isSafeUrl(args.url)) {
      return errResult('URL blocked by safety check', 'unsafe_url', started);
    }
    const hash = urlHash(args.url);
    const memoryOn = isMemoryEnabled();

    // 24h cache
    if (!args.bypass_cache && memoryOn) {
      try {
        const db = getDb();
        const rows = await db
          .select()
          .from(scraped_pages)
          .where(eq(scraped_pages.url_hash, hash))
          .limit(1);
        const row = rows[0];
        if (row && Date.now() - row.fetched_at.getTime() < CACHE_TTL_MS) {
          const content = row.title ? `# ${row.title}\n\n${row.content_md}` : row.content_md;
          return {
            status: 'ok',
            content,
            meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: true },
          };
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'web_get_cache_read_failed');
      }
    }

    const tiers = args.force_tool ? [args.force_tool] : pickTiers(args.url);
    let lastErr: ToolResult | null = null;
    for (const tier of tiers) {
      logger.debug({ url: args.url, tier }, 'web_get_try_tier');
      const r = await runTier(tier, args.url, ctx);
      if (r.status === 'ok') {
        if (memoryOn) {
          try {
            const db = getDb();
            await db
              .insert(scraped_pages)
              .values({
                url_hash: hash,
                url: args.url,
                content_md: r.content,
                source_tool: tier,
              })
              .onConflictDoUpdate({
                target: scraped_pages.url_hash,
                set: {
                  content_md: r.content,
                  source_tool: tier,
                  fetched_at: new Date(),
                },
              });
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, url: args.url },
              'web_get_cache_write_failed',
            );
          }
        }
        return {
          ...r,
          meta: {
            ...r.meta,
            cache_hit: false,
            latency_ms: Date.now() - started,
          },
        };
      }
      lastErr = r;
      logger.debug(
        { url: args.url, tier, error: r.error },
        'web_get_tier_failed',
      );
    }
    return (
      lastErr ?? errResult(`all tiers failed for ${args.url}`, 'all_tiers_failed', started)
    );
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
