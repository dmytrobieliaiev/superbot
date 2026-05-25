import ExcelJS from 'exceljs';
import { isStorageEnabled, storeBlob, getPresignedUrl } from '../../storage/s3.js';
import { uploadBufferToSlack } from '../../slack/upload.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface SheetSpec {
  name: string;
  headers?: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

interface XlsxArgs {
  sheets: SheetSpec[];
  filename?: string;
  title?: string;
  /** If false, skip Slack upload and only return URL. Default true. */
  upload_to_slack?: boolean;
}

const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLS = 1_000;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'file';
}

export const xlsx_build: ToolSpec<XlsxArgs> = {
  name: 'xlsx_build',
  description:
    'Build an .xlsx workbook from sheets of rows and upload to current Slack thread. Each sheet: {name, headers?, rows}. Returns Slack permalink + storage URL.',
  params_schema: {
    type: 'object',
    properties: {
      sheets: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 31 },
            headers: { type: 'array', items: { type: 'string' } },
            rows: {
              type: 'array',
              items: {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
          required: ['name', 'rows'],
          additionalProperties: false,
        },
      },
      filename: { type: 'string', description: 'Without extension. Defaults to workbook-<ts>.' },
      title: { type: 'string' },
      upload_to_slack: { type: 'boolean', default: true },
    },
    required: ['sheets'],
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      for (const s of args.sheets) {
        if (s.rows.length > MAX_ROWS_PER_SHEET) {
          return errResult(
            `sheet "${s.name}" too large: ${s.rows.length} rows > ${MAX_ROWS_PER_SHEET}`,
            'too_many_rows',
            started,
          );
        }
        const widest = s.rows.reduce((a, r) => Math.max(a, r.length), s.headers?.length ?? 0);
        if (widest > MAX_COLS) {
          return errResult(
            `sheet "${s.name}" too wide: ${widest} cols > ${MAX_COLS}`,
            'too_many_cols',
            started,
          );
        }
      }

      const wb = new ExcelJS.Workbook();
      wb.creator = 'superbot';
      wb.created = new Date();
      for (const s of args.sheets) {
        const ws = wb.addWorksheet(sanitize(s.name).slice(0, 31));
        if (s.headers && s.headers.length > 0) {
          ws.addRow(s.headers);
          ws.getRow(1).font = { bold: true };
        }
        for (const row of s.rows) ws.addRow(row);
        ws.columns.forEach((col) => {
          let max = 10;
          col.eachCell?.({ includeEmpty: false }, (cell) => {
            const len = String(cell.value ?? '').length;
            if (len > max) max = Math.min(len, 60);
          });
          col.width = max + 2;
        });
      }

      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${sanitize(args.filename ?? 'workbook')}-${stamp}.xlsx`;

      let storageUrl: string | undefined;
      if (isStorageEnabled()) {
        const key = `${new Date().toISOString().slice(0, 10)}/${filename}`;
        await storeBlob('files', key, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        storageUrl = await getPresignedUrl('files', key);
      }

      let slackPermalink: string | undefined;
      let slackError: string | undefined;
      if (args.upload_to_slack !== false) {
        const up = await uploadBufferToSlack(buf, {
          channel: ctx.channel_id,
          ...(ctx.thread_ts ? { thread_ts: ctx.thread_ts } : {}),
          filename,
          title: args.title ?? filename,
        });
        if (up.ok && up.permalink) slackPermalink = up.permalink;
        else if (!up.ok) slackError = up.error;
      }

      const sizeKb = (buf.length / 1024).toFixed(1);
      const parts = [
        `xlsx built: ${filename} (${sizeKb} KB, ${args.sheets.length} sheet(s))`,
      ];
      if (slackPermalink) parts.push(`slack: ${slackPermalink}`);
      if (storageUrl) parts.push(`storage: ${storageUrl}`);
      if (slackError) parts.push(`slack_upload_failed: ${slackError}`);

      return {
        status: 'ok',
        content: parts.join('\n'),
        artifacts: [
          {
            name: filename,
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ...(storageUrl ? { url: storageUrl } : {}),
            size_bytes: buf.length,
          },
        ],
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      return errResult(`xlsx_build error: ${(err as Error).message}`, (err as Error).message, started);
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
