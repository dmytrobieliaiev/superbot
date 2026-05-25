import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { uploadBufferToSlack } from '../../slack/upload.js';
import { getPresignedUrl, isStorageEnabled, storeBlob } from '../../storage/s3.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TIMEOUT_MS = 30_000;
const PDF_BUCKET = 'pdf';

type Source = 'html' | 'markdown';

interface PdfArgs {
  source: Source;
  content: string;
  filename?: string;
  /** If false, skip Slack upload and only return storage URL. Default true. */
  upload_to_slack?: boolean;
  /** Optional message posted alongside the file in Slack. */
  initial_comment?: string;
}

const MD_TO_HTML_STYLE = `<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; padding: 2em; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3 { line-height: 1.3; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 2px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 0.4em 0.8em; }
  th { background: #f0f0f0; }
  img { max-width: 100%; }
</style>`;

function markdownToHtml(md: string): string {
  // Minimal MD → HTML. Use a real markdown lib for production.
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = escaped
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>');
  return `<!doctype html><html><head><meta charset="utf-8">${MD_TO_HTML_STYLE}</head><body><p>${html}</p></body></html>`;
}

function gotenbergBase(): string {
  return (env.GOTENBERG_URL ?? 'http://gotenberg:3000').replace(/\/$/, '');
}

export const pdf_render: ToolSpec<PdfArgs> = {
  name: 'pdf_render',
  description:
    'Render HTML or Markdown to a PDF via Gotenberg and upload to the current Slack thread (default). Returns Slack permalink + presigned storage URL.',
  params_schema: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['html', 'markdown'] },
      content: { type: 'string', description: 'HTML or Markdown body' },
      filename: { type: 'string', default: 'document.pdf' },
      upload_to_slack: { type: 'boolean', default: true },
      initial_comment: { type: 'string' },
    },
    required: ['source', 'content'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    const wantUpload = args.upload_to_slack !== false;
    if (!isStorageEnabled() && !wantUpload) {
      return errResult(
        'No output destination — storage disabled and upload_to_slack=false',
        'no_destination',
        started,
      );
    }
    const html = args.source === 'markdown' ? markdownToHtml(args.content) : args.content;
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(`${gotenbergBase()}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return errResult(
          `gotenberg http_${resp.status}: ${text.slice(0, 200)}`,
          `http_${resp.status}`,
          started,
        );
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const filename = args.filename ?? 'document.pdf';

      let storageUrl: string | undefined;
      if (isStorageEnabled()) {
        const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.pdf`;
        await storeBlob(PDF_BUCKET, key, buf, 'application/pdf');
        storageUrl = await getPresignedUrl(PDF_BUCKET, key);
      }

      let slackPermalink: string | undefined;
      let slackError: string | undefined;
      if (wantUpload) {
        const up = await uploadBufferToSlack(buf, {
          channel: ctx.channel_id,
          ...(ctx.thread_ts ? { thread_ts: ctx.thread_ts } : {}),
          filename,
          title: filename,
          ...(args.initial_comment ? { initial_comment: args.initial_comment } : {}),
        });
        if (up.ok && up.permalink) slackPermalink = up.permalink;
        else if (!up.ok) slackError = up.error;
      }

      const sizeKb = (buf.length / 1024).toFixed(1);
      const parts = [`📎 PDF rendered: ${filename} (${sizeKb} KB)`];
      if (slackPermalink) parts.push(`slack: ${slackPermalink}`);
      if (storageUrl) parts.push(`storage: ${storageUrl}`);
      if (slackError) parts.push(`slack_upload_failed: ${slackError}`);

      return {
        status: 'ok',
        content: parts.join('\n'),
        artifacts: [
          {
            name: filename,
            mime: 'application/pdf',
            ...(storageUrl ? { url: storageUrl } : {}),
            size_bytes: buf.length,
          },
        ],
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'pdf_render_failed');
      return errResult(
        `pdf_render error: ${(err as Error).message}`,
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
