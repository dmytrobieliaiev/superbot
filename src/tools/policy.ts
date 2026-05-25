import { logger } from '../logger.js';
import type { ToolContext, ToolResult, ToolSpec } from './types.js';

export interface PolicyOpts {
  timeout_ms?: number;
  max_retries?: number;
  base_backoff_ms?: number;
}

const DEFAULTS: Required<PolicyOpts> = {
  timeout_ms: 30_000,
  max_retries: 2,
  base_backoff_ms: 500,
};

const NON_RETRYABLE_ERRORS = new Set([
  'no_api_key',
  'unsafe_url',
  'http_400',
  'http_401',
  'http_403',
  'http_404',
  'http_422',
  'acl_tool',
  'acl_channel',
  'requires_confirmation',
  'unknown_tool',
]);

function isRetryable(error?: string): boolean {
  if (!error) return true;
  if (NON_RETRYABLE_ERRORS.has(error)) return false;
  return true;
}

async function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('policy_timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withPolicy<TArgs>(
  tool: ToolSpec<TArgs>,
  args: TArgs,
  ctx: ToolContext,
  opts: PolicyOpts = {},
): Promise<ToolResult> {
  const o = { ...DEFAULTS, ...opts };
  let lastErr: ToolResult | undefined;

  for (let attempt = 0; attempt <= o.max_retries; attempt++) {
    if (attempt > 0) {
      const delay = o.base_backoff_ms * Math.pow(2, attempt - 1);
      logger.debug({ tool: tool.name, attempt, delay }, 'tool retry');
      await sleep(delay);
    }
    try {
      const result = await runWithTimeout(tool.execute(args, ctx), o.timeout_ms);
      if (result.status === 'ok') return result;
      if (!isRetryable(result.error)) return result;
      lastErr = result;
    } catch (err) {
      lastErr = {
        status: 'error',
        content: `tool ${tool.name} threw: ${(err as Error).message}`,
        error: (err as Error).message === 'policy_timeout' ? 'timeout' : (err as Error).message,
        meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
      };
    }
  }

  return (
    lastErr ?? {
      status: 'error',
      content: `tool ${tool.name} failed after retries`,
      meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
    }
  );
}
