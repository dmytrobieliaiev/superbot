import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 15_000;

type Action = 'list_issues' | 'get_issue' | 'list_projects';

interface LinearArgs {
  action: Action;
  team_key?: string;
  state?: string;
  assignee_email?: string;
  id?: string;
  limit?: number;
}

async function linearQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY not set');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(LINEAR_GRAPHQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: env.LINEAR_API_KEY,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`http_${resp.status}`);
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }
    if (!json.data) throw new Error('no data');
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

interface IssueNode {
  identifier: string;
  title: string;
  state: { name: string };
  assignee: { name: string } | null;
  priority: number;
  url: string;
}

export const linear: ToolSpec<LinearArgs> = {
  name: 'linear',
  description:
    'Read-only Linear access. Actions: list_issues, get_issue, list_projects. Filter by team_key, state, assignee_email.',
  params_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_issues', 'get_issue', 'list_projects'] },
      team_key: { type: 'string', description: 'Team key (e.g. "ENG")' },
      state: { type: 'string', description: 'State name (e.g. "In Progress")' },
      assignee_email: { type: 'string' },
      id: { type: 'string', description: 'Issue identifier (e.g. ENG-123) for get_issue' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.LINEAR_API_KEY) {
      return errResult('LINEAR_API_KEY not set', 'no_api_key', started);
    }
    try {
      let content = '';
      if (args.action === 'list_issues') {
        const filter: Record<string, unknown> = {};
        if (args.team_key) filter.team = { key: { eq: args.team_key } };
        if (args.state) filter.state = { name: { eq: args.state } };
        if (args.assignee_email) filter.assignee = { email: { eq: args.assignee_email } };
        const data = await linearQuery<{ issues: { nodes: IssueNode[] } }>(
          `query($filter: IssueFilter, $first: Int!) {
            issues(filter: $filter, first: $first) {
              nodes { identifier title state { name } assignee { name } priority url }
            }
          }`,
          { filter, first: args.limit ?? 30 },
        );
        content =
          data.issues.nodes
            .map(
              (i) =>
                `${i.identifier} [${i.state.name}] ${i.title}${i.assignee ? ` — ${i.assignee.name}` : ''}\n${i.url}`,
            )
            .join('\n\n') || '(no issues)';
      } else if (args.action === 'get_issue') {
        if (!args.id) throw new Error('id required (e.g. ENG-123)');
        const data = await linearQuery<{ issue: { identifier: string; title: string; state: { name: string }; description: string | null; url: string } | null }>(
          `query($id: String!) {
            issue(id: $id) { identifier title state { name } description url }
          }`,
          { id: args.id },
        );
        if (!data.issue) {
          content = `issue ${args.id} not found`;
        } else {
          const i = data.issue;
          content = `${i.identifier} [${i.state.name}] ${i.title}\n${i.url}\n\n${i.description ?? '(no description)'}`;
        }
      } else if (args.action === 'list_projects') {
        const data = await linearQuery<{ projects: { nodes: Array<{ id: string; name: string; state: string; progress: number }> } }>(
          `query { projects(first: 50) { nodes { id name state progress } } }`,
          {},
        );
        content =
          data.projects.nodes
            .map((p) => `${p.name} [${p.state}] ${Math.round(p.progress * 100)}%`)
            .join('\n') || '(no projects)';
      } else {
        throw new Error(`unknown action: ${args.action as string}`);
      }
      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, action: args.action }, 'linear_failed');
      return errResult(
        `linear ${args.action} error: ${(err as Error).message}`,
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
