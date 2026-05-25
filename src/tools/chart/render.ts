import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration, ChartType } from 'chart.js';
import { isStorageEnabled, storeBlob, getPresignedUrl } from '../../storage/s3.js';
import { uploadBufferToSlack } from '../../slack/upload.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface Dataset {
  label?: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string;
}

interface ChartArgs {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter';
  labels?: (string | number)[];
  datasets: Dataset[];
  title?: string;
  width?: number;
  height?: number;
  filename?: string;
  upload_to_slack?: boolean;
}

const DEFAULT_W = 900;
const DEFAULT_H = 540;
const MAX_DIM = 2400;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'chart';
}

// Singleton canvas to avoid recreating per call
let canvas: ChartJSNodeCanvas | null = null;
function getCanvas(w: number, h: number): ChartJSNodeCanvas {
  if (canvas && (canvas as unknown as { width: number; height: number }).width === w) return canvas;
  canvas = new ChartJSNodeCanvas({ width: w, height: h, backgroundColour: '#ffffff' });
  return canvas;
}

export const chart_render: ToolSpec<ChartArgs> = {
  name: 'chart_render',
  description:
    'Render a chart as PNG via Chart.js and upload to current Slack thread. Types: bar, line, pie, doughnut, scatter.',
  params_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut', 'scatter'] },
      labels: {
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      datasets: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            data: { type: 'array', items: { type: 'number' } },
            backgroundColor: {
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            borderColor: { type: 'string' },
          },
          required: ['data'],
          additionalProperties: false,
        },
      },
      title: { type: 'string' },
      width: { type: 'integer', minimum: 200, maximum: MAX_DIM, default: DEFAULT_W },
      height: { type: 'integer', minimum: 200, maximum: MAX_DIM, default: DEFAULT_H },
      filename: { type: 'string' },
      upload_to_slack: { type: 'boolean', default: true },
    },
    required: ['type', 'datasets'],
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const w = args.width ?? DEFAULT_W;
      const h = args.height ?? DEFAULT_H;
      const cv = getCanvas(w, h);

      const config: ChartConfiguration = {
        type: args.type as ChartType,
        data: {
          ...(args.labels ? { labels: args.labels } : {}),
          datasets: args.datasets,
        },
        options: {
          responsive: false,
          plugins: {
            title: args.title
              ? { display: true, text: args.title, font: { size: 16 } }
              : { display: false },
            legend: { display: args.datasets.length > 1 || args.type === 'pie' || args.type === 'doughnut' },
          },
        },
      };

      const buf = await cv.renderToBuffer(config, 'image/png');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${sanitize(args.filename ?? args.title ?? 'chart')}-${stamp}.png`;

      let storageUrl: string | undefined;
      if (isStorageEnabled()) {
        const key = `${new Date().toISOString().slice(0, 10)}/${filename}`;
        await storeBlob('files', key, buf, 'image/png');
        storageUrl = await getPresignedUrl('files', key);
      }

      let slackPermalink: string | undefined;
      if (args.upload_to_slack !== false) {
        const up = await uploadBufferToSlack(buf, {
          channel: ctx.channel_id,
          filename,
          title: args.title ?? filename,
        });
        if (up.ok && up.permalink) slackPermalink = up.permalink;
      }

      const parts = [`chart rendered: ${filename} (${(buf.length / 1024).toFixed(1)} KB)`];
      if (slackPermalink) parts.push(`slack: ${slackPermalink}`);
      if (storageUrl) parts.push(`storage: ${storageUrl}`);

      return {
        status: 'ok',
        content: parts.join('\n'),
        artifacts: [
          {
            name: filename,
            mime: 'image/png',
            ...(storageUrl ? { url: storageUrl } : {}),
            size_bytes: buf.length,
          },
        ],
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      return {
        status: 'error',
        content: `chart_render error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
