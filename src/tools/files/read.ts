import { logger } from '../../logger.js';
import { env } from '../../config/env.js';
import { slackClient } from '../../slack/client.js';
import type { ToolResult, ToolSpec } from '../types.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const TIMEOUT_MS = 30_000;

interface FileReadArgs {
  file_id: string;
  max_chars?: number;
}

interface SlackFileInfo {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  size?: number;
}

async function downloadFile(url: string): Promise<Buffer> {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN not set');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`download_failed http_${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      throw new Error(`file too large: ${buf.length} bytes > ${MAX_BYTES}`);
    }
    return buf;
  } finally {
    clearTimeout(t);
  }
}

async function extractText(buf: Buffer, mime: string, name: string): Promise<string> {
  // Lazy-load heavy parsers
  if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    return r.text;
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.toLowerCase().endsWith('.docx')
  ) {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    /\.(txt|md|csv|json|ya?ml|toml|tsv)$/i.test(name)
  ) {
    return buf.toString('utf-8');
  }
  throw new Error(`unsupported mime: ${mime} (${name})`);
}

export const file_read: ToolSpec<FileReadArgs> = {
  name: 'file_read',
  description:
    'Read text content from a Slack-uploaded file (PDF, DOCX, TXT, MD, CSV, JSON). Pass the file_id from the Slack file object.',
  params_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'Slack file id (e.g. F0123…)' },
      max_chars: {
        type: 'integer',
        minimum: 100,
        maximum: 200_000,
        default: 50_000,
      },
    },
    required: ['file_id'],
    additionalProperties: false,
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const info = await slackClient().files.info({ file: args.file_id });
      const f = info.file as SlackFileInfo;
      if (!f.url_private || !f.mimetype || !f.name) {
        throw new Error('file metadata incomplete');
      }
      if ((f.size ?? 0) > MAX_BYTES) {
        throw new Error(`file too large: ${f.size} > ${MAX_BYTES}`);
      }
      const buf = await downloadFile(f.url_private);
      const text = await extractText(buf, f.mimetype, f.name);
      const max = args.max_chars ?? 50_000;
      const truncated = text.length > max;
      const content = truncated ? text.slice(0, max) + '\n\n…[truncated]' : text;
      return {
        status: 'ok',
        content: `📄 ${f.name} (${f.mimetype}, ${f.size ?? 0} bytes)\n\n${content}`,
        meta: {
          latency_ms: Date.now() - started,
          cost_usd: 0,
          cache_hit: false,
          truncated,
        },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, file_id: args.file_id }, 'file_read failed');
      return {
        status: 'error',
        content: `file_read error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
