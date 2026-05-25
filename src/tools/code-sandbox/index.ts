import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface SandboxArgs {
  language: 'python' | 'javascript';
  code: string;
  timeout_ms?: number;
}

export const code_sandbox: ToolSpec<SandboxArgs> = {
  name: 'code_sandbox',
  description:
    'Run Python or JavaScript in an E2B cloud sandbox. Returns stdout, stderr, and any rich outputs (plots, dataframes). 60s default timeout.',
  params_schema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript'] },
      code: { type: 'string', description: 'Code to execute' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 60000, default: 60000 },
    },
    required: ['language', 'code'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.01,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.E2B_API_KEY) {
      return errResult('E2B_API_KEY not set', 'no_api_key', started);
    }
    try {
      const { Sandbox } = await import('@e2b/code-interpreter');
      const sandbox = await Sandbox.create({ apiKey: env.E2B_API_KEY });
      try {
        const execution = await sandbox.runCode(args.code, {
          language: args.language === 'python' ? 'python' : 'js',
          timeoutMs: args.timeout_ms ?? 60_000,
        });
        const parts: string[] = [];
        if (execution.logs.stdout.length > 0) {
          parts.push(`stdout:\n${execution.logs.stdout.join('\n')}`);
        }
        if (execution.logs.stderr.length > 0) {
          parts.push(`stderr:\n${execution.logs.stderr.join('\n')}`);
        }
        if (execution.error) {
          parts.push(`error: ${execution.error.name}: ${execution.error.value}\n${execution.error.traceback ?? ''}`);
        }
        if (execution.results.length > 0) {
          parts.push(
            `results: ${execution.results.length} item(s)\n${execution.results
              .map((r, i) => `[${i}] ${r.text ?? '(non-text result)'}`)
              .join('\n')}`,
          );
        }
        const content = parts.join('\n\n') || '(no output)';
        return {
          status: execution.error ? 'error' : 'ok',
          content,
          meta: { latency_ms: Date.now() - started, cost_usd: 0.01, cache_hit: false },
        };
      } finally {
        await sandbox.kill().catch(() => undefined);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'code_sandbox_failed');
      return errResult(
        `code_sandbox error: ${(err as Error).message}`,
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
