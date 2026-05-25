import { existsSync, readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';
import { logger } from '../logger.js';

const McpServerSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/, 'name: lowercase letters/digits/_/-'),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  disabled: z.boolean().default(false),
});

const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
});

export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
}

function interpolateMap(m: Record<string, string> | undefined): Record<string, string> {
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k] = interpolate(v);
  return out;
}

export function loadMcpConfig(path = 'config/mcp.yaml'): McpConfig {
  if (!existsSync(path)) {
    return { servers: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = McpConfigSchema.parse(yamlParse(raw));
    return parsed;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, path },
      'mcp_config_parse_failed',
    );
    return { servers: [] };
  }
}

export function resolveServerConfig(cfg: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...cfg };
  if (cfg.env) out.env = interpolateMap(cfg.env);
  if (cfg.headers) out.headers = interpolateMap(cfg.headers);
  if (cfg.url) out.url = interpolate(cfg.url);
  if (cfg.command) out.command = interpolate(cfg.command);
  if (cfg.args) out.args = cfg.args.map(interpolate);
  return out;
}
