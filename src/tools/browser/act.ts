import { randomUUID } from 'node:crypto';
import { checkToolAcl } from '../../config/tool-acl.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { uploadBufferToSlack } from '../../slack/upload.js';
import { isStorageEnabled, storeBlob, getPresignedUrl } from '../../storage/s3.js';
import { isSafeUrl } from '../util/safe-url.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TIMEOUT_MS = 90_000;
const MAX_ACTIONS = 40;

type Action =
  | { type: 'goto'; url: string; wait_until?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string; delay_ms?: number }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'select'; selector: string; value: string | string[] }
  | { type: 'check'; selector: string; checked?: boolean }
  | { type: 'hover'; selector: string }
  | { type: 'press_key'; key: string }
  | { type: 'wait_selector'; selector: string; timeout_ms?: number; state?: 'visible' | 'attached' | 'hidden' | 'detached' }
  | { type: 'wait_ms'; ms: number }
  | { type: 'extract_text'; selector: string; name?: string }
  | { type: 'extract_attr'; selector: string; attr: string; name?: string }
  | { type: 'extract_html'; selector?: string; name?: string }
  | { type: 'screenshot'; full_page?: boolean; name?: string }
  | { type: 'scroll'; selector?: string; y?: number }
  | { type: 'eval'; expr: string; name?: string };

interface ActArgs {
  url: string;
  actions: Action[];
  user_agent?: string;
  viewport?: { width: number; height: number };
  /** Upload any captured screenshots to current Slack thread. Default true. */
  upload_screenshots?: boolean;
}

function browserlessBase(): string {
  const base = env.BROWSERLESS_URL ?? 'http://browserless:3000';
  return base.replace(/\/$/, '');
}

function buildScript(args: ActArgs): string {
  const acts = JSON.stringify(args.actions);
  const ua = args.user_agent ? JSON.stringify(args.user_agent) : 'null';
  const vp = args.viewport ? JSON.stringify(args.viewport) : 'null';
  // Runs inside Browserless /function — `page` + `context` provided.
  return `
    module.exports = async ({ page, context }) => {
      const actions = ${acts};
      const userAgent = ${ua};
      const viewport = ${vp};
      const extracts = {};
      const screenshots = [];
      if (userAgent) await page.setUserAgent ? page.setUserAgent(userAgent) : context.setExtraHTTPHeaders({ 'user-agent': userAgent });
      if (viewport) await page.setViewport ? page.setViewport(viewport) : page.setViewportSize(viewport);
      let stepIndex = 0;
      try {
        for (const a of actions) {
          stepIndex++;
          if (a.type === 'goto') {
            await page.goto(a.url, { waitUntil: a.wait_until || 'load', timeout: 30000 });
          } else if (a.type === 'click') {
            await page.click(a.selector, { timeout: 15000 });
          } else if (a.type === 'type') {
            await page.type(a.selector, a.text, a.delay_ms ? { delay: a.delay_ms } : {});
          } else if (a.type === 'fill') {
            await (page.fill ? page.fill(a.selector, a.text) : page.$eval(a.selector, (el, v) => { el.value = v; }, a.text));
          } else if (a.type === 'select') {
            const v = Array.isArray(a.value) ? a.value : [a.value];
            await (page.selectOption ? page.selectOption(a.selector, v) : page.select(a.selector, ...v));
          } else if (a.type === 'check') {
            const checked = a.checked !== false;
            if (page.setChecked) await page.setChecked(a.selector, checked);
            else await page.$eval(a.selector, (el, c) => { el.checked = c; }, checked);
          } else if (a.type === 'hover') {
            await page.hover(a.selector);
          } else if (a.type === 'press_key') {
            await page.keyboard.press(a.key);
          } else if (a.type === 'wait_selector') {
            await page.waitForSelector(a.selector, { timeout: a.timeout_ms || 15000, state: a.state || 'visible' });
          } else if (a.type === 'wait_ms') {
            await new Promise(r => setTimeout(r, Math.min(a.ms, 30000)));
          } else if (a.type === 'scroll') {
            if (a.selector) await page.$eval(a.selector, el => el.scrollIntoView({ block: 'center' }));
            else await page.evaluate(y => window.scrollTo(0, y || document.body.scrollHeight), a.y);
          } else if (a.type === 'extract_text') {
            const txt = await page.$eval(a.selector, el => el.innerText || el.textContent || '');
            extracts[a.name || ('text_' + stepIndex)] = txt.trim().slice(0, 20000);
          } else if (a.type === 'extract_attr') {
            const val = await page.$eval(a.selector, (el, attr) => el.getAttribute(attr), a.attr);
            extracts[a.name || ('attr_' + stepIndex)] = val;
          } else if (a.type === 'extract_html') {
            const html = a.selector
              ? await page.$eval(a.selector, el => el.outerHTML)
              : await page.content();
            extracts[a.name || ('html_' + stepIndex)] = html.slice(0, 100000);
          } else if (a.type === 'screenshot') {
            const buf = await page.screenshot({ fullPage: !!a.full_page, type: 'png' });
            screenshots.push({ name: a.name || ('shot_' + stepIndex), base64: buf.toString('base64') });
          } else if (a.type === 'eval') {
            const v = await page.evaluate(new Function('return (' + a.expr + ')')());
            extracts[a.name || ('eval_' + stepIndex)] = v == null ? null : (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
          } else {
            throw new Error('unknown action type: ' + a.type);
          }
        }
      } catch (err) {
        return {
          data: {
            ok: false,
            error: err.message,
            failed_at: stepIndex,
            final_url: page.url(),
            extracts,
            screenshots,
          },
          type: 'application/json',
        };
      }
      return {
        data: {
          ok: true,
          final_url: page.url(),
          extracts,
          screenshots,
        },
        type: 'application/json',
      };
    };
  `;
}

interface FnResult {
  ok: boolean;
  error?: string;
  failed_at?: number;
  final_url?: string;
  extracts?: Record<string, unknown>;
  screenshots?: Array<{ name: string; base64: string }>;
}

export const browser_act: ToolSpec<ActArgs> = {
  name: 'browser_act',
  description:
    'Drive a headless Chromium session: navigate, click, type, select, wait, extract text/attrs, screenshot. Stateless — single ordered action list per call. Use for forms, login flows, dynamic data extraction.',
  params_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ACTIONS,
        items: { type: 'object' },
      },
      user_agent: { type: 'string' },
      viewport: {
        type: 'object',
        properties: {
          width: { type: 'integer', minimum: 200, maximum: 3840 },
          height: { type: 'integer', minimum: 200, maximum: 2160 },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      upload_screenshots: { type: 'boolean', default: true },
    },
    required: ['url', 'actions'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.01,
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isSafeUrl(args.url)) {
      return err('URL blocked by safety check', 'unsafe_url', started);
    }
    // Block `eval` action unless explicitly allowed via slack_dm-style ACL key
    if (args.actions.some((a) => a.type === 'eval')) {
      if (!checkToolAcl('browser_act_eval', ctx.channel_id, ctx.user_id)) {
        return err(
          'browser_act: `eval` action not allowed for this user/channel (gate via browser_act_eval ACL)',
          'acl_eval',
          started,
        );
      }
    }
    // First action must be goto (or seed from args.url). We always prepend a goto unless first is goto.
    const first = args.actions[0];
    const actions: Action[] =
      first && first.type === 'goto' ? args.actions : [{ type: 'goto', url: args.url }, ...args.actions];
    if (actions.length > MAX_ACTIONS) {
      return err(`too many actions: ${actions.length} > ${MAX_ACTIONS}`, 'too_many_actions', started);
    }

    const tokenQuery = env.BROWSERLESS_TOKEN ? `?token=${encodeURIComponent(env.BROWSERLESS_TOKEN)}` : '';
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const code = buildScript({ ...args, actions });
      const resp = await fetch(`${browserlessBase()}/function${tokenQuery}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, context: {} }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return err(
          `browserless http_${resp.status}: ${text.slice(0, 200)}`,
          `http_${resp.status}`,
          started,
        );
      }
      const result = (await resp.json()) as FnResult;

      // Upload screenshots if any
      const uploaded: Array<{ name: string; url?: string; permalink?: string }> = [];
      const artifactList: ToolResult['artifacts'] = [];
      for (const s of result.screenshots ?? []) {
        const buf = Buffer.from(s.base64, 'base64');
        const filename = `${s.name}-${randomUUID().slice(0, 8)}.png`;
        let storageUrl: string | undefined;
        if (isStorageEnabled()) {
          const key = `${new Date().toISOString().slice(0, 10)}/${filename}`;
          await storeBlob('screenshots', key, buf, 'image/png');
          storageUrl = await getPresignedUrl('screenshots', key);
        }
        let permalink: string | undefined;
        if (args.upload_screenshots !== false) {
          const up = await uploadBufferToSlack(buf, {
            channel: ctx.channel_id,
            filename,
            title: s.name,
          });
          if (up.ok && up.permalink) permalink = up.permalink;
        }
        const entry: { name: string; url?: string; permalink?: string } = { name: s.name };
        if (storageUrl) entry.url = storageUrl;
        if (permalink) entry.permalink = permalink;
        uploaded.push(entry);
        artifactList.push({
          name: filename,
          mime: 'image/png',
          ...(storageUrl ? { url: storageUrl } : {}),
          size_bytes: buf.length,
        });
      }

      const lines: string[] = [];
      lines.push(`browser_act ${result.ok ? 'ok' : 'failed'} — final_url=${result.final_url ?? '?'}`);
      if (!result.ok) lines.push(`error at step ${result.failed_at}: ${result.error}`);
      if (result.extracts && Object.keys(result.extracts).length > 0) {
        lines.push('extracts:');
        for (const [k, v] of Object.entries(result.extracts)) {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          lines.push(`  ${k}: ${s.length > 500 ? s.slice(0, 500) + '…' : s}`);
        }
      }
      if (uploaded.length > 0) {
        lines.push('screenshots:');
        for (const u of uploaded) {
          lines.push(`  ${u.name}: ${u.permalink ?? u.url ?? '(no url)'}`);
        }
      }

      return {
        status: result.ok ? 'ok' : 'error',
        content: lines.join('\n'),
        ...(artifactList.length > 0 ? { artifacts: artifactList } : {}),
        ...(result.ok ? {} : { error: result.error ?? 'browser_act_failed' }),
        meta: { latency_ms: Date.now() - started, cost_usd: 0.01, cache_hit: false },
      };
    } catch (e) {
      const ex = e as Error & { cause?: { code?: string; syscall?: string; address?: string; port?: number; hostname?: string; message?: string } };
      const cause = ex.cause ?? {};
      logger.warn(
        {
          err: ex.message,
          name: ex.name,
          cause_code: cause.code,
          cause_syscall: cause.syscall,
          cause_address: cause.address,
          cause_port: cause.port,
          cause_hostname: cause.hostname,
          cause_message: cause.message,
          browserless_base: browserlessBase(),
          token_present: !!env.BROWSERLESS_TOKEN,
          url: args.url,
        },
        'browser_act_failed',
      );
      return err(
        `browser_act error: ${ex.message}${cause.code ? ` (${cause.syscall ?? ''} ${cause.code} ${cause.address ?? ''}:${cause.port ?? ''})`.trim() : ''}`,
        ex.name === 'AbortError' ? 'timeout' : (cause.code ?? ex.message),
        started,
      );
    } finally {
      clearTimeout(t);
    }
  },
};

function err(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
