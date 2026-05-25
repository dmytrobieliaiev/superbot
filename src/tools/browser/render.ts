import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { isSafeUrl } from '../util/safe-url.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TIMEOUT_MS = 60_000;

type Action = 'content' | 'screenshot';

interface BrowserArgs {
  action: Action;
  url: string;
  wait_for_selector?: string;
  full_page?: boolean;
}

function browserlessBase(): string {
  const base = env.BROWSERLESS_URL ?? 'http://browserless:3000';
  return base.replace(/\/$/, '');
}

export const browser_render: ToolSpec<BrowserArgs> = {
  name: 'browser_render',
  description:
    'Render a JS-heavy page via headless Chromium (Browserless). Actions: content (HTML/markdown), screenshot (PNG to MinIO).',
  params_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['content', 'screenshot'] },
      url: { type: 'string', format: 'uri' },
      wait_for_selector: { type: 'string' },
      full_page: { type: 'boolean', default: true },
    },
    required: ['action', 'url'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.005,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isSafeUrl(args.url)) {
      return errResult('URL blocked by safety check', 'unsafe_url', started);
    }

    const tokenQuery = env.BROWSERLESS_TOKEN ? `?token=${encodeURIComponent(env.BROWSERLESS_TOKEN)}` : '';
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      if (args.action === 'content') {
        const body: Record<string, unknown> = { url: args.url };
        if (args.wait_for_selector) body.waitForSelector = { selector: args.wait_for_selector };
        const resp = await fetch(`${browserlessBase()}/content${tokenQuery}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return errResult(
            `browserless content http_${resp.status}: ${text.slice(0, 200)}`,
            `http_${resp.status}`,
            started,
          );
        }
        const html = await resp.text();
        return {
          status: 'ok',
          content: html,
          meta: { latency_ms: Date.now() - started, cost_usd: 0.005, cache_hit: false },
        };
      }
      if (args.action === 'screenshot') {
        const body: Record<string, unknown> = {
          url: args.url,
          options: { fullPage: args.full_page ?? true, type: 'png' },
        };
        if (args.wait_for_selector) body.waitForSelector = { selector: args.wait_for_selector };
        const resp = await fetch(`${browserlessBase()}/screenshot${tokenQuery}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return errResult(
            `browserless screenshot http_${resp.status}: ${text.slice(0, 200)}`,
            `http_${resp.status}`,
            started,
          );
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        // Store via MinIO if configured; else inline base64.
        const { isStorageEnabled, storeBlob, getPresignedUrl } = await import('../../storage/s3.js');
        if (isStorageEnabled()) {
          const { randomUUID } = await import('node:crypto');
          const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.png`;
          await storeBlob('screenshots', key, buf, 'image/png');
          const url = await getPresignedUrl('screenshots', key);
          return {
            status: 'ok',
            content: `screenshot saved: ${url}`,
            artifacts: [{ name: 'screenshot.png', mime: 'image/png', url, size_bytes: buf.length }],
            meta: { latency_ms: Date.now() - started, cost_usd: 0.005, cache_hit: false },
          };
        }
        return {
          status: 'ok',
          content: `screenshot ${buf.length} bytes (no storage configured; inline base64 omitted)`,
          meta: { latency_ms: Date.now() - started, cost_usd: 0.005, cache_hit: false },
        };
      }
      return errResult(`unknown action: ${args.action as string}`, 'bad_args', started);
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; errno?: string; syscall?: string; address?: string; port?: number; hostname?: string; message?: string } };
      const cause = e.cause ?? {};
      logger.warn(
        {
          err: e.message,
          name: e.name,
          stack: e.stack?.split('\n').slice(0, 3).join('\n'),
          cause_code: cause.code,
          cause_errno: cause.errno,
          cause_syscall: cause.syscall,
          cause_address: cause.address,
          cause_port: cause.port,
          cause_hostname: cause.hostname,
          cause_message: cause.message,
          browserless_base: browserlessBase(),
          token_present: !!env.BROWSERLESS_TOKEN,
          action: args.action,
          url: args.url,
        },
        'browser_render_failed',
      );
      const detail =
        cause.code || cause.syscall
          ? ` (${cause.syscall ?? ''} ${cause.code ?? ''} ${cause.address ?? ''}:${cause.port ?? ''})`.trim()
          : '';
      return errResult(
        `browser_render error: ${e.message}${detail}`,
        e.name === 'AbortError' ? 'timeout' : (cause.code ?? e.message),
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
