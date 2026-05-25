import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

const REPLICATE_BASE = 'https://api.replicate.com/v1';
const REPLICATE_URL = `${REPLICATE_BASE}/predictions`;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 60_000;

interface ImageGenArgs {
  prompt: string;
  model?: string; // owner/name:version
  width?: number;
  height?: number;
}

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[];
  error?: string | null;
}

async function pollUntilDone(id: string, token: string): Promise<ReplicatePrediction> {
  const started = Date.now();
  while (Date.now() - started < POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await fetch(`${REPLICATE_URL}/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`poll http_${resp.status}`);
    const p = (await resp.json()) as ReplicatePrediction;
    if (p.status === 'succeeded' || p.status === 'failed' || p.status === 'canceled') {
      return p;
    }
  }
  throw new Error('replicate poll timeout');
}

export const image_gen: ToolSpec<ImageGenArgs> = {
  name: 'image_gen',
  description:
    'Generate an image from a text prompt via Replicate. Returns the image URL(s).',
  params_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Image description' },
      model: {
        type: 'string',
        description:
          'Replicate model. Accepts "owner/name" (official models — uses latest) or "owner/name:version" (pinned). Defaults to REPLICATE_MODEL env.',
      },
      width: { type: 'integer', default: 1024 },
      height: { type: 'integer', default: 1024 },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.05,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.REPLICATE_API_TOKEN) {
      return errResult('REPLICATE_API_TOKEN not set', 'no_api_key', started);
    }
    const token = env.REPLICATE_API_TOKEN.trim();
    if (token !== env.REPLICATE_API_TOKEN) {
      logger.warn('REPLICATE_API_TOKEN had surrounding whitespace — trimmed');
    }
    const tokenFp = token.length >= 8
      ? `${token.slice(0, 4)}…${token.slice(-4)} (len=${token.length})`
      : '(too short)';
    const model = args.model ?? env.REPLICATE_MODEL;
    if (!model) {
      return errResult(
        'no model specified (pass `model` arg or set REPLICATE_MODEL env)',
        'bad_args',
        started,
      );
    }
    // Two routes:
    //   "owner/name:version" → POST /v1/predictions with { version, input }
    //   "owner/name"         → POST /v1/models/{owner}/{name}/predictions with { input }
    const pinnedMatch = model.match(/^([^/]+)\/([^:]+):(.+)$/);
    const officialMatch = model.match(/^([^/]+)\/([^/:]+)$/);
    let endpoint: string;
    let body: Record<string, unknown>;
    const input = {
      prompt: args.prompt,
      width: args.width ?? 1024,
      height: args.height ?? 1024,
    };
    if (pinnedMatch) {
      endpoint = REPLICATE_URL;
      body = { version: pinnedMatch[3], input };
    } else if (officialMatch) {
      endpoint = `${REPLICATE_BASE}/models/${officialMatch[1]}/${officialMatch[2]}/predictions`;
      body = { input };
    } else {
      return errResult(
        'model must be "owner/name" or "owner/name:version"',
        'bad_args',
        started,
      );
    }
    try {
      const createResp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          Prefer: 'wait=1',
        },
        body: JSON.stringify(body),
      });
      if (!createResp.ok) {
        const text = await createResp.text().catch(() => '');
        logger.warn(
          {
            status: createResp.status,
            endpoint,
            model,
            token_fp: tokenFp,
            body: text.slice(0, 300),
          },
          'replicate_create_failed',
        );
        return errResult(
          `replicate create http_${createResp.status} (token=${tokenFp}, model=${model}): ${text.slice(0, 200)}`,
          `http_${createResp.status}`,
          started,
        );
      }
      const created = (await createResp.json()) as ReplicatePrediction;
      const final =
        created.status === 'succeeded' || created.status === 'failed'
          ? created
          : await pollUntilDone(created.id, token);
      if (final.status !== 'succeeded') {
        return errResult(
          `replicate ${final.status}: ${final.error ?? ''}`,
          final.status,
          started,
        );
      }
      const urls = Array.isArray(final.output) ? final.output : final.output ? [final.output] : [];
      const content = urls.length > 0 ? urls.join('\n') : '(no output urls)';
      return {
        status: 'ok',
        content,
        artifacts: urls.map((url, i) => ({
          name: `image_${i}.png`,
          mime: 'image/png',
          url,
          size_bytes: 0,
        })),
        meta: { latency_ms: Date.now() - started, cost_usd: 0.05, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'image_gen_failed');
      return errResult(
        `image_gen error: ${(err as Error).message}`,
        (err as Error).message,
        started,
      );
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
