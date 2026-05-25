#!/usr/bin/env tsx
// MCP server for Multica (multica.ai) — managed-agents platform.
// Transport: stdio. Spawned by src/mcp/manager.ts via config/mcp.yaml.
//
// Env required:
//   MULTICA_BASE_URL       e.g. https://multica.ai (cloud) or self-hosted URL
//   MULTICA_API_TOKEN      PAT starting with `mul_` — Settings → Personal Access Tokens
//   MULTICA_WORKSPACE_SLUG default workspace slug for all calls (can be overridden per-tool)
//
// Exposed tools (namespaced as mcp_multica_<name> in the bot):
//   create_issue, quick_create_issue, list_issues, get_issue,
//   update_issue, search_issues, list_projects, list_agents

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = process.env.MULTICA_BASE_URL?.replace(/\/$/, '');
const TOKEN = process.env.MULTICA_API_TOKEN;
const DEFAULT_WORKSPACE_SLUG = process.env.MULTICA_WORKSPACE_SLUG;
const DEFAULT_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID;
const TIMEOUT_MS = 20_000;
const MAX_TEXT_BYTES = 60_000;

if (!BASE_URL || !TOKEN) {
  // eslint-disable-next-line no-console
  console.error('multica-mcp: MULTICA_BASE_URL and MULTICA_API_TOKEN must be set');
  process.exit(2);
}
if (!DEFAULT_WORKSPACE_SLUG && !DEFAULT_WORKSPACE_ID) {
  // eslint-disable-next-line no-console
  console.error(
    'multica-mcp: MULTICA_WORKSPACE_SLUG or MULTICA_WORKSPACE_ID must be set as default',
  );
  process.exit(2);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ApiOpts {
  workspaceSlug?: string;
  workspaceId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

function buildHeaders(opts: ApiOpts): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  };
  const slug = opts.workspaceSlug ?? DEFAULT_WORKSPACE_SLUG;
  const id = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (slug) h['X-Workspace-Slug'] = slug;
  else if (id) h['X-Workspace-ID'] = id;
  if (opts.body !== undefined) h['content-type'] = 'application/json';
  return h;
}

function buildUrl(path: string, query?: ApiOpts['query']): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function api<T>(method: Method, path: string, opts: ApiOpts = {}): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method,
      headers: buildHeaders(opts),
      signal: controller.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const resp = await fetch(buildUrl(path, opts.query), init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`multica ${method} ${path} http_${resp.status}: ${text.slice(0, 400)}`);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function truncate(text: string, max = MAX_TEXT_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n…[truncated]';
}

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

interface IssueResp {
  id: string;
  workspace_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_type: string | null;
  assignee_id: string | null;
  project_id: string | null;
  parent_issue_id: string | null;
  start_date: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectResp {
  id: string;
  name: string;
  slug?: string;
  description?: string | null;
  status?: string;
  updated_at?: string;
}

interface AgentResp {
  id: string;
  name: string;
  slug?: string;
  provider?: string;
  archived?: boolean;
}

function compactIssue(i: IssueResp): Record<string, unknown> {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    status: i.status,
    priority: i.priority,
    assignee_type: i.assignee_type,
    assignee_id: i.assignee_id,
    project_id: i.project_id,
    parent_issue_id: i.parent_issue_id,
    start_date: i.start_date,
    due_date: i.due_date,
    description: i.description ? truncate(i.description, 8000) : null,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

const server = new McpServer({ name: 'multica', version: '0.1.0' });

const workspaceFields = {
  workspace_slug: z.string().optional().describe('Override default workspace slug for this call'),
  workspace_id: z.string().optional().describe('Override default workspace UUID for this call'),
};

server.registerTool(
  'create_issue',
  {
    title: 'Create a Multica issue',
    description:
      'Create a new issue in the configured Multica workspace. Returns the created issue with id, identifier, and status. Assignee can be a user or an agent — use list_agents to resolve agent ids first.',
    inputSchema: {
      title: z.string().min(1).describe('Issue title (required)'),
      description: z.string().optional().describe('Markdown body'),
      status: z
        .string()
        .optional()
        .describe('Status key (e.g. "backlog", "todo", "in_progress", "done"). Workspace default used if omitted.'),
      priority: z
        .string()
        .optional()
        .describe('Priority key (e.g. "no_priority", "low", "medium", "high", "urgent")'),
      assignee_type: z.enum(['user', 'agent', 'squad']).optional(),
      assignee_id: z.string().optional().describe('UUID of assignee — required when assignee_type is set'),
      project_id: z.string().optional(),
      parent_issue_id: z.string().optional(),
      start_date: z.string().optional().describe('YYYY-MM-DD'),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      ...workspaceFields,
    },
  },
  async (args) => {
    const body: Record<string, unknown> = { title: args.title };
    if (args.description !== undefined) body.description = args.description;
    if (args.status !== undefined) body.status = args.status;
    if (args.priority !== undefined) body.priority = args.priority;
    if (args.assignee_type !== undefined) body.assignee_type = args.assignee_type;
    if (args.assignee_id !== undefined) body.assignee_id = args.assignee_id;
    if (args.project_id !== undefined) body.project_id = args.project_id;
    if (args.parent_issue_id !== undefined) body.parent_issue_id = args.parent_issue_id;
    if (args.start_date !== undefined) body.start_date = args.start_date;
    if (args.due_date !== undefined) body.due_date = args.due_date;
    const issue = await api<IssueResp>('POST', '/api/issues', {
      body,
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    return jsonResult({ issue: compactIssue(issue) });
  },
);

server.registerTool(
  'quick_create_issue',
  {
    title: 'Quick-create an issue from a prompt',
    description:
      'Create an issue and auto-route it to an agent or squad in one call. The prompt becomes the issue title/description. Returns the queued task id.',
    inputSchema: {
      prompt: z.string().min(1).describe('Natural-language task prompt'),
      agent_id: z.string().optional().describe('UUID of target agent (mutually exclusive with squad_id)'),
      squad_id: z.string().optional().describe('UUID of target squad'),
      project_id: z.string().optional(),
      ...workspaceFields,
    },
  },
  async (args) => {
    const body: Record<string, unknown> = { prompt: args.prompt };
    if (args.agent_id) body.agent_id = args.agent_id;
    if (args.squad_id) body.squad_id = args.squad_id;
    if (args.project_id) body.project_id = args.project_id;
    const r = await api<{ task_id: string }>('POST', '/api/issues/quick-create', {
      body,
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    return jsonResult(r);
  },
);

server.registerTool(
  'get_issue',
  {
    title: 'Fetch a Multica issue by id',
    description: 'Return full issue object including description, status, assignee, dates.',
    inputSchema: {
      id: z.string().describe('Issue UUID'),
      ...workspaceFields,
    },
  },
  async (args) => {
    const issue = await api<IssueResp>('GET', `/api/issues/${encodeURIComponent(args.id)}`, {
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    return jsonResult({ issue: compactIssue(issue) });
  },
);

server.registerTool(
  'list_issues',
  {
    title: 'List Multica issues',
    description:
      'List issues in the workspace. Supports filtering by status, assignee, project. Returns compact issue summaries.',
    inputSchema: {
      status: z.string().optional(),
      assignee_id: z.string().optional(),
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25).optional(),
      offset: z.number().int().min(0).default(0).optional(),
      ...workspaceFields,
    },
  },
  async (args) => {
    const r = await api<{ issues: IssueResp[]; total?: number }>('GET', '/api/issues', {
      query: {
        ...(args.status ? { status: args.status } : {}),
        ...(args.assignee_id ? { assignee_id: args.assignee_id } : {}),
        ...(args.project_id ? { project_id: args.project_id } : {}),
        limit: args.limit ?? 25,
        offset: args.offset ?? 0,
      },
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    const issues = (r.issues ?? []).map(compactIssue);
    return jsonResult({ count: issues.length, total: r.total, issues });
  },
);

server.registerTool(
  'search_issues',
  {
    title: 'Full-text search issues',
    description: 'Search issues by title/description/comments. Returns ranked matches with snippets.',
    inputSchema: {
      q: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(50).default(15).optional(),
      ...workspaceFields,
    },
  },
  async (args) => {
    const r = await api<{ results?: Array<IssueResp & { matched_snippet?: string }> }>(
      'GET',
      '/api/issues/search',
      {
        query: { q: args.q, limit: args.limit ?? 15 },
        ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
        ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
      },
    );
    const hits = (r.results ?? []).map((it) => ({
      ...compactIssue(it),
      ...(it.matched_snippet ? { matched_snippet: truncate(it.matched_snippet, 600) } : {}),
    }));
    return jsonResult({ query: args.q, count: hits.length, results: hits });
  },
);

server.registerTool(
  'update_issue',
  {
    title: 'Update a Multica issue',
    description:
      'Patch an issue. Only the fields provided are changed. Use to reassign, change status/priority, set dates, or move to project.',
    inputSchema: {
      id: z.string().describe('Issue UUID'),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      assignee_type: z.enum(['user', 'agent', 'squad']).nullable().optional(),
      assignee_id: z.string().nullable().optional(),
      project_id: z.string().nullable().optional(),
      start_date: z.string().nullable().optional().describe('YYYY-MM-DD or null to clear'),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD or null to clear'),
      ...workspaceFields,
    },
  },
  async (args) => {
    const body: Record<string, unknown> = {};
    for (const k of [
      'title',
      'description',
      'status',
      'priority',
      'assignee_type',
      'assignee_id',
      'project_id',
      'start_date',
      'due_date',
    ] as const) {
      if (args[k] !== undefined) body[k] = args[k];
    }
    const issue = await api<IssueResp>('PUT', `/api/issues/${encodeURIComponent(args.id)}`, {
      body,
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    return jsonResult({ issue: compactIssue(issue) });
  },
);

server.registerTool(
  'list_projects',
  {
    title: 'List Multica projects',
    description: 'List workspace projects with id + name. Use to resolve project_id before creating an issue.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50).optional(),
      ...workspaceFields,
    },
  },
  async (args) => {
    const r = await api<{ projects?: ProjectResp[] } | ProjectResp[]>('GET', '/api/projects', {
      query: { limit: args.limit ?? 50 },
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    const list = Array.isArray(r) ? r : r.projects ?? [];
    return jsonResult({
      count: list.length,
      projects: list.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        updated_at: p.updated_at,
      })),
    });
  },
);

server.registerTool(
  'list_agents',
  {
    title: 'List Multica agents',
    description:
      'List workspace agents with id + name. Use to resolve assignee_id for assigning issues to a specific agent.',
    inputSchema: {
      include_archived: z.boolean().default(false).optional(),
      ...workspaceFields,
    },
  },
  async (args) => {
    const r = await api<{ agents?: AgentResp[] } | AgentResp[]>('GET', '/api/agents', {
      query: { include_archived: args.include_archived ?? false },
      ...(args.workspace_slug ? { workspaceSlug: args.workspace_slug } : {}),
      ...(args.workspace_id ? { workspaceId: args.workspace_id } : {}),
    });
    const list = Array.isArray(r) ? r : r.agents ?? [];
    return jsonResult({
      count: list.length,
      agents: list.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        provider: a.provider,
        archived: a.archived,
      })),
    });
  },
);

await server.connect(new StdioServerTransport());
