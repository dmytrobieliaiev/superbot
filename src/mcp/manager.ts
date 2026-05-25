import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  loadMcpConfig,
  resolveServerConfig,
  type McpServerConfig,
} from '../config/mcp.js';
import { logger } from '../logger.js';
import { register } from '../tools/registry.js';
import type { ToolResult, ToolSpec } from '../tools/types.js';

interface McpHandle {
  name: string;
  client: Client;
  tool_names: string[];
}

const handles: McpHandle[] = [];

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

interface McpToolCallResult {
  content?: McpContentItem[];
  isError?: boolean;
}

function makeTransport(
  cfg: McpServerConfig,
): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error(`mcp ${cfg.name}: command required for stdio`);
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
  }
  if (cfg.transport === 'sse') {
    if (!cfg.url) throw new Error(`mcp ${cfg.name}: url required for sse`);
    const opts: { requestInit?: { headers: Record<string, string> } } = {};
    if (cfg.headers) opts.requestInit = { headers: cfg.headers };
    return new SSEClientTransport(new URL(cfg.url), opts);
  }
  // http (streamable)
  if (!cfg.url) throw new Error(`mcp ${cfg.name}: url required for http`);
  const opts: { requestInit?: { headers: Record<string, string> } } = {};
  if (cfg.headers) opts.requestInit = { headers: cfg.headers };
  return new StreamableHTTPClientTransport(new URL(cfg.url), opts);
}

function formatContent(items: McpContentItem[] | undefined): string {
  if (!items || items.length === 0) return '(empty result)';
  return items
    .map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image') return `[image ${c.mimeType ?? 'unknown'}]`;
      if (c.type === 'resource') return `[resource]`;
      return JSON.stringify(c);
    })
    .join('\n');
}

function wrapMcpTool(client: Client, serverName: string, tool: McpToolInfo): ToolSpec {
  const fullName = `mcp_${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const schema =
    (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object' };
  return {
    name: fullName,
    description: `[MCP/${serverName}] ${tool.description ?? tool.name}`,
    params_schema: schema as ToolSpec['params_schema'],
    async execute(args, _ctx): Promise<ToolResult> {
      const started = Date.now();
      try {
        const result = (await client.callTool({
          name: tool.name,
          arguments: args as Record<string, unknown>,
        })) as McpToolCallResult;
        const text = formatContent(result.content);
        return {
          status: result.isError ? 'error' : 'ok',
          content: text,
          meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
          ...(result.isError ? { error: 'mcp_tool_error' } : {}),
        };
      } catch (err) {
        return {
          status: 'error',
          content: `mcp ${serverName}/${tool.name} error: ${(err as Error).message}`,
          error: (err as Error).message,
          meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
        };
      }
    },
  };
}

async function connectOne(cfg: McpServerConfig): Promise<McpHandle | null> {
  if (cfg.disabled) {
    logger.debug({ name: cfg.name }, 'mcp_server_disabled');
    return null;
  }
  const resolved = resolveServerConfig(cfg);
  try {
    const transport = makeTransport(resolved);
    const client = new Client(
      { name: 'superbot', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const listed = (await client.listTools()) as { tools: McpToolInfo[] };
    const tool_names: string[] = [];
    for (const t of listed.tools) {
      const spec = wrapMcpTool(client, cfg.name, t);
      register(spec);
      tool_names.push(spec.name);
    }
    logger.info(
      { name: cfg.name, transport: cfg.transport, tools: tool_names.length },
      'mcp_server_connected',
    );
    return { name: cfg.name, client, tool_names };
  } catch (err) {
    logger.warn(
      { name: cfg.name, transport: cfg.transport, err: (err as Error).message },
      'mcp_server_connect_failed',
    );
    return null;
  }
}

/**
 * Connect to all configured MCP servers in parallel. Failures are logged
 * but do not block boot. Tools are registered into the global registry
 * with the prefix `mcp_<server>_<tool>`.
 */
export async function initMcpServers(): Promise<void> {
  const config = loadMcpConfig();
  if (config.servers.length === 0) {
    logger.info('mcp: no servers configured');
    return;
  }
  const connected = await Promise.all(config.servers.map(connectOne));
  for (const h of connected) {
    if (h) handles.push(h);
  }
  logger.info(
    {
      total_servers: config.servers.length,
      connected: handles.length,
      total_mcp_tools: handles.reduce((acc, h) => acc + h.tool_names.length, 0),
    },
    'mcp_init_done',
  );
}

export async function closeMcpServers(): Promise<void> {
  for (const h of handles) {
    try {
      await h.client.close();
      logger.debug({ name: h.name }, 'mcp_server_closed');
    } catch (err) {
      logger.warn(
        { name: h.name, err: (err as Error).message },
        'mcp_server_close_failed',
      );
    }
  }
  handles.length = 0;
}

export function listMcpServers(): Array<{ name: string; tools: string[] }> {
  return handles.map((h) => ({ name: h.name, tools: h.tool_names }));
}
