import { Octokit } from '@octokit/rest';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

type Action = 'list_issues' | 'get_issue' | 'list_prs' | 'get_pr' | 'search_code' | 'get_file';

interface GithubArgs {
  action: Action;
  repo?: string;
  number?: number;
  query?: string;
  path?: string;
  ref?: string;
  state?: 'open' | 'closed' | 'all';
}

let _client: Octokit | null = null;
function client(): Octokit {
  if (_client) return _client;
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  _client = new Octokit({ auth: env.GITHUB_TOKEN });
  return _client;
}

function parseRepo(s: string): { owner: string; repo: string } {
  const [owner, repo] = s.split('/');
  if (!owner || !repo) throw new Error('repo must be "owner/name"');
  return { owner, repo };
}

export const github: ToolSpec<GithubArgs> = {
  name: 'github',
  description:
    'Read-only GitHub access. Actions: list_issues, get_issue, list_prs, get_pr, search_code, get_file. repo format "owner/name".',
  params_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_issues', 'get_issue', 'list_prs', 'get_pr', 'search_code', 'get_file'],
      },
      repo: { type: 'string', description: '"owner/name"' },
      number: { type: 'integer', description: 'Issue or PR number' },
      query: { type: 'string', description: 'Query for search_code (use qualifiers like repo:owner/name)' },
      path: { type: 'string', description: 'File path for get_file' },
      ref: { type: 'string', description: 'Branch/tag/sha for get_file' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!env.GITHUB_TOKEN) {
      return errResult('GITHUB_TOKEN not set', 'no_api_key', started);
    }
    try {
      const o = client();
      let content = '';
      switch (args.action) {
        case 'list_issues': {
          const { owner, repo } = parseRepo(args.repo ?? '');
          const r = await o.issues.listForRepo({
            owner,
            repo,
            state: args.state ?? 'open',
            per_page: 30,
          });
          content = r.data
            .filter((i) => !i.pull_request)
            .map((i) => `#${i.number} ${i.title} [${i.state}] by ${i.user?.login ?? '?'}`)
            .join('\n') || '(no issues)';
          break;
        }
        case 'get_issue': {
          if (!args.number) throw new Error('number required');
          const { owner, repo } = parseRepo(args.repo ?? '');
          const r = await o.issues.get({ owner, repo, issue_number: args.number });
          content = `#${r.data.number} ${r.data.title}\nstate: ${r.data.state}\nby: ${r.data.user?.login ?? '?'}\n\n${r.data.body ?? '(no body)'}`;
          break;
        }
        case 'list_prs': {
          const { owner, repo } = parseRepo(args.repo ?? '');
          const r = await o.pulls.list({
            owner,
            repo,
            state: args.state ?? 'open',
            per_page: 30,
          });
          content = r.data
            .map(
              (p) => `#${p.number} ${p.title} [${p.state}] ${p.head.ref}→${p.base.ref} by ${p.user?.login ?? '?'}`,
            )
            .join('\n') || '(no PRs)';
          break;
        }
        case 'get_pr': {
          if (!args.number) throw new Error('number required');
          const { owner, repo } = parseRepo(args.repo ?? '');
          const r = await o.pulls.get({ owner, repo, pull_number: args.number });
          content = `#${r.data.number} ${r.data.title}\nstate: ${r.data.state}\n${r.data.head.ref} → ${r.data.base.ref}\nby: ${r.data.user?.login ?? '?'}\n\n${r.data.body ?? '(no body)'}\n\n+${r.data.additions ?? 0} -${r.data.deletions ?? 0} across ${r.data.changed_files ?? 0} files`;
          break;
        }
        case 'search_code': {
          if (!args.query) throw new Error('query required');
          const r = await o.search.code({ q: args.query, per_page: 20 });
          content = r.data.items
            .map((it) => `${it.repository.full_name}/${it.path}`)
            .join('\n') || '(no matches)';
          break;
        }
        case 'get_file': {
          if (!args.path) throw new Error('path required');
          const { owner, repo } = parseRepo(args.repo ?? '');
          const opts: { owner: string; repo: string; path: string; ref?: string } = {
            owner,
            repo,
            path: args.path,
          };
          if (args.ref) opts.ref = args.ref;
          const r = await o.repos.getContent(opts);
          if (Array.isArray(r.data)) {
            content = r.data.map((d) => `${d.type}\t${d.name}`).join('\n');
          } else if ('content' in r.data && r.data.content) {
            const decoded = Buffer.from(r.data.content, 'base64').toString('utf-8');
            content = `${r.data.path} (${r.data.size ?? 0} bytes)\n\n${decoded}`;
          } else {
            content = '(unsupported content type)';
          }
          break;
        }
        default:
          throw new Error(`unknown action: ${args.action as string}`);
      }
      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, action: args.action }, 'github_failed');
      return errResult(
        `github ${args.action} error: ${(err as Error).message}`,
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
