import type { Redis } from 'ioredis';
import { logAudit } from '../audit.js';
import { checkToolAcl } from '../config/tool-acl.js';
import { track } from '../lifecycle.js';
import { logger } from '../logger.js';
import { m_tool_calls, m_tool_errors, m_tool_latency } from '../metrics.js';
import { postConfirmPrompt } from '../slack/modal.js';
import { getCachedToolResult, setCachedToolResult } from './cache.js';
import { withPolicy, type PolicyOpts } from './policy.js';
import { get as getTool } from './registry.js';
import { truncateResult } from './truncate.js';
import type { ToolContext, ToolResult } from './types.js';

export interface ExecuteOpts extends PolicyOpts {
  use_cache?: boolean;
  max_content_chars?: number;
}

function errorResult(message: string, code: string): ToolResult {
  return {
    status: 'error',
    content: message,
    error: code,
    meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
  };
}

export async function executeTool(
  redis: Redis,
  toolName: string,
  args: unknown,
  ctx: ToolContext,
  opts: ExecuteOpts = {},
): Promise<ToolResult> {
  const tool = getTool(toolName);
  if (!tool) return errorResult(`unknown tool: ${toolName}`, 'unknown_tool');

  // Tool-level ACL (declared by the tool itself)
  if (tool.acl && !tool.acl(ctx)) {
    return errorResult(`tool ${toolName} denied by tool ACL`, 'acl_tool');
  }

  // Channel/user ACL (from tool-acl.yaml)
  if (!checkToolAcl(toolName, ctx.channel_id, ctx.user_id)) {
    logger.info(
      { tool: toolName, channel_id: ctx.channel_id, user_id: ctx.user_id },
      'tool_acl_denied',
    );
    return errorResult(`tool ${toolName} denied by channel/user ACL`, 'acl_channel');
  }

  // M5.6: destructive ops require user confirmation via Slack modal
  if (tool.destructive && !ctx.confirmed_destructive) {
    const token = await postConfirmPrompt(redis, ctx.channel_id, toolName, args, ctx.user_id);
    return {
      status: 'error',
      content: `tool ${toolName} is destructive — posted confirmation prompt (token: ${token.slice(0, 8)}). After user confirms, retry the request.`,
      error: 'requires_confirmation',
      meta: { latency_ms: 0, cost_usd: 0, cache_hit: false },
    };
  }

  const useCache = opts.use_cache ?? true;
  if (useCache) {
    const cached = await getCachedToolResult(redis, toolName, args);
    if (cached) {
      logger.debug({ tool: toolName }, 'tool_cache_hit');
      return await truncateResult(cached, opts.max_content_chars);
    }
  }

  const policyOpts: PolicyOpts = {};
  if (opts.timeout_ms !== undefined) policyOpts.timeout_ms = opts.timeout_ms;
  if (opts.max_retries !== undefined) policyOpts.max_retries = opts.max_retries;
  if (opts.base_backoff_ms !== undefined) policyOpts.base_backoff_ms = opts.base_backoff_ms;

  const result = await withPolicy(tool, args, ctx, policyOpts);

  if (result.status === 'ok' && useCache) {
    await setCachedToolResult(redis, toolName, args, result);
  }

  // Metrics
  m_tool_calls.inc({ tool: toolName, status: result.status });
  if (result.status === 'error') {
    m_tool_errors.inc({ tool: toolName, error_code: result.error ?? 'unknown' });
  }
  m_tool_latency.observe({ tool: toolName }, result.meta.latency_ms / 1000);

  // Audit log: tool call complete
  void track(
    logAudit({
      actor: 'agent',
      action: `tool:${toolName}`,
      payload: {
        turn_id: ctx.turn_id,
        user_id: ctx.user_id,
        channel_id: ctx.channel_id,
        args,
        status: result.status,
        latency_ms: result.meta.latency_ms,
        cost_usd: result.meta.cost_usd,
        cache_hit: result.meta.cache_hit,
      },
    }),
  );

  return await truncateResult(result, opts.max_content_chars);
}
