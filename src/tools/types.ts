// Shared tool framework types.
// Per-tool implementations live under src/tools/<group>/<name>.ts.
// M5 wires registry + tool-use loop on top of these primitives.

import type { JSONSchema7 } from 'json-schema';

export type ToolResultStatus = 'ok' | 'error';

export interface ToolArtifact {
  name: string;
  mime: string;
  /** Presigned URL once stored in MinIO (M5.4). */
  url?: string;
  /** Inline data if no external storage available. */
  data?: string;
  size_bytes: number;
}

export interface ToolResultMeta {
  latency_ms: number;
  cost_usd: number;
  cache_hit: boolean;
  truncated?: boolean;
}

export interface ToolResult {
  status: ToolResultStatus;
  /** Content as shown to the LLM (post-truncation). */
  content: string;
  artifacts?: ToolArtifact[];
  meta: ToolResultMeta;
  error?: string;
}

export interface ToolContext {
  turn_id: string;
  user_id: string;
  channel_id: string;
  channel_type: string;
  /** Active Slack thread ts — used by tools that post inline (e.g. slack_blocks). */
  thread_ts?: string;
  /** Set true once the user has confirmed a destructive op via modal (M5.6). */
  confirmed_destructive?: boolean;
}

export interface ToolSpec<TArgs = unknown> {
  name: string;
  description: string;
  /** True → must be confirmed via modal before execute (M5.6). */
  destructive?: boolean;
  /** JSON Schema for the args object — exported to LLM function-calling. */
  params_schema: JSONSchema7;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
  acl?(ctx: ToolContext): boolean;
  cost_estimate?(args: TArgs): number;
}
