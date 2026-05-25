import type { Queue } from 'bullmq';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import {
  audit_log,
  cron_jobs,
  eval_runs,
  eval_set,
  facts,
  scraped_pages,
  skills,
  trajectories,
} from '../db/schema.js';
import { logger } from '../logger.js';
import type { EnrichedEvent } from './types.js';

export function isAdmin(user_id: string): boolean {
  if (!env.ADMIN_USER_IDS) return false;
  return env.ADMIN_USER_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(user_id);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

interface UserAggRow {
  user_id: string;
  n: number;
  cost: number;
}
interface ToolAggRow {
  tool: string;
  n: number;
  errors: number;
}

const SECTIONS = {
  overview: 'overview',
  users: 'users',
  tools: 'tools',
  cost: 'cost',
  memory: 'memory',
  queue: 'queue',
  errors: 'errors',
  help: 'help',
};

const HELP = `*\`/admin\` subcommands:*
\`overview\` (default) — health snapshot
\`users [hours=24]\` — top users by turns + cost
\`tools [hours=24]\` — tool call counts + error rates
\`cost [hours=24]\` — cost breakdown by user / channel / model
\`memory\` — fact / skill / eval-set / scraped-pages counts
\`queue\` — BullMQ queue depth + recent failed jobs
\`errors [hours=24]\` — recent errored turns
\`help\` — this message`;

export async function renderOverview(
  queue: Queue<EnrichedEvent>,
): Promise<string> {
  const lines: string[] = ['*🛠️ Superbot Admin — Overview*'];
  if (isMemoryEnabled()) {
    const db = getDb();
    const since24 = hoursAgo(24);
    const since7d = hoursAgo(24 * 7);

    const [act24] = await db
      .select({
        n: count(),
        cost: sql<number>`coalesce(sum(${trajectories.cost_usd})::real, 0)`,
        tokens: sql<number>`coalesce(sum(${trajectories.tokens_in} + ${trajectories.tokens_out})::int, 0)`,
      })
      .from(trajectories)
      .where(gte(trajectories.created_at, since24));

    const [act7d] = await db
      .select({
        n: count(),
        cost: sql<number>`coalesce(sum(${trajectories.cost_usd})::real, 0)`,
      })
      .from(trajectories)
      .where(gte(trajectories.created_at, since7d));

    const [errs24] = await db
      .select({ n: count() })
      .from(trajectories)
      .where(
        and(gte(trajectories.created_at, since24), eq(trajectories.outcome, 'errored')),
      );

    const errRate =
      (act24?.n ?? 0) > 0 ? (errs24?.n ?? 0) / (act24?.n ?? 1) : 0;

    lines.push(
      `*Activity*  24h: ${act24?.n ?? 0} turns / ${fmtUsd(act24?.cost ?? 0)} / ${act24?.tokens ?? 0} tok`,
    );
    lines.push(
      `             7d: ${act7d?.n ?? 0} turns / ${fmtUsd(act7d?.cost ?? 0)}`,
    );
    lines.push(`*Error rate 24h:* ${fmtPct(errRate)} (${errs24?.n ?? 0} turns)`);

    const [factsRow] = await db
      .select({ c: count() })
      .from(facts)
      .where(eq(facts.contradicted, false));
    const [skillsRow] = await db
      .select({ c: count() })
      .from(skills)
      .where(eq(skills.active, true));
    const [evalSetRow] = await db.select({ c: count() }).from(eval_set);
    const [auditRow] = await db.select({ c: count() }).from(audit_log);

    lines.push(
      `*Memory*     facts=${factsRow?.c ?? 0}  skills=${skillsRow?.c ?? 0}  eval_set=${evalSetRow?.c ?? 0}  audit=${auditRow?.c ?? 0}`,
    );

    const lastEval = await db
      .select()
      .from(eval_runs)
      .orderBy(desc(eval_runs.ran_at))
      .limit(1);
    const lastEvalRow = lastEval[0];
    if (lastEvalRow) {
      lines.push(
        `*Last eval*  avg=${(lastEvalRow.avg_score ?? 0).toFixed(2)} at ${lastEvalRow.ran_at.toISOString()}`,
      );
    }
  } else {
    lines.push('_DB not configured — limited info_');
  }

  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    lines.push(
      `*Queue*      waiting=${counts.waiting ?? 0}  active=${counts.active ?? 0}  delayed=${counts.delayed ?? 0}  failed=${counts.failed ?? 0}`,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'admin_queue_counts_failed');
  }

  lines.push(`\n_Use \`/admin help\` for subcommands._`);
  return lines.join('\n');
}

export async function renderUsers(hours: number): Promise<string> {
  if (!isMemoryEnabled()) return '_DB not configured_';
  const db = getDb();
  const since = hoursAgo(hours);
  const rows = (await db.execute(sql`
    SELECT user_id,
           count(*)::int AS n,
           coalesce(sum(cost_usd)::real, 0) AS cost
    FROM trajectories
    WHERE created_at >= ${since}
    GROUP BY user_id
    ORDER BY n DESC
    LIMIT 15
  `)) as unknown as UserAggRow[];

  if (rows.length === 0) return `_no activity in last ${hours}h_`;

  const lines = [`*Top users — last ${hours}h*`];
  for (const r of rows) {
    lines.push(`• <@${r.user_id}>  ${r.n} turns  ${fmtUsd(r.cost)}`);
  }
  return lines.join('\n');
}

export async function renderTools(hours: number): Promise<string> {
  if (!isMemoryEnabled()) return '_DB not configured_';
  const db = getDb();
  const since = hoursAgo(hours);
  const rows = (await db.execute(sql`
    SELECT
      substring(action from 6) AS tool,
      count(*)::int AS n,
      sum(case when payload->>'status' = 'error' then 1 else 0 end)::int AS errors
    FROM audit_log
    WHERE ts >= ${since} AND action LIKE 'tool:%'
    GROUP BY tool
    ORDER BY n DESC
    LIMIT 30
  `)) as unknown as ToolAggRow[];

  if (rows.length === 0) return `_no tool calls in last ${hours}h_`;

  const lines = [`*Tools — last ${hours}h*`];
  for (const r of rows) {
    const errRate = r.n > 0 ? r.errors / r.n : 0;
    const flag = errRate > 0.2 ? ' ⚠️' : '';
    lines.push(`• \`${r.tool}\`  ${r.n} calls  ${r.errors} err (${fmtPct(errRate)})${flag}`);
  }
  return lines.join('\n');
}

export async function renderCost(hours: number): Promise<string> {
  if (!isMemoryEnabled()) return '_DB not configured_';
  const db = getDb();
  const since = hoursAgo(hours);

  const [tot] = await db
    .select({
      n: count(),
      cost: sql<number>`coalesce(sum(${trajectories.cost_usd})::real, 0)`,
      tokens: sql<number>`coalesce(sum(${trajectories.tokens_in} + ${trajectories.tokens_out})::int, 0)`,
    })
    .from(trajectories)
    .where(gte(trajectories.created_at, since));

  const byUser = (await db.execute(sql`
    SELECT user_id, count(*)::int AS n, coalesce(sum(cost_usd)::real, 0) AS cost
    FROM trajectories
    WHERE created_at >= ${since}
    GROUP BY user_id
    ORDER BY cost DESC
    LIMIT 10
  `)) as unknown as UserAggRow[];

  const byChannel = (await db.execute(sql`
    SELECT channel_id, count(*)::int AS n, coalesce(sum(cost_usd)::real, 0) AS cost
    FROM trajectories
    WHERE created_at >= ${since}
    GROUP BY channel_id
    ORDER BY cost DESC
    LIMIT 10
  `)) as unknown as Array<{ channel_id: string; n: number; cost: number }>;

  const lines = [
    `*Cost — last ${hours}h*`,
    `total: ${fmtUsd(tot?.cost ?? 0)} across ${tot?.n ?? 0} turns (${tot?.tokens ?? 0} tok)`,
    '',
    '*By user:*',
  ];
  for (const u of byUser) {
    lines.push(`• <@${u.user_id}>  ${fmtUsd(u.cost)}  (${u.n} turns)`);
  }
  lines.push('', '*By channel:*');
  for (const c of byChannel) {
    lines.push(`• <#${c.channel_id}>  ${fmtUsd(c.cost)}  (${c.n} turns)`);
  }
  return lines.join('\n');
}

export async function renderMemory(): Promise<string> {
  if (!isMemoryEnabled()) return '_DB not configured_';
  const db = getDb();
  const [factsActive] = await db
    .select({ c: count() })
    .from(facts)
    .where(eq(facts.contradicted, false));
  const [factsContradicted] = await db
    .select({ c: count() })
    .from(facts)
    .where(eq(facts.contradicted, true));
  const [skillsActive] = await db
    .select({ c: count() })
    .from(skills)
    .where(eq(skills.active, true));
  const [skillsAll] = await db.select({ c: count() }).from(skills);
  const [evalSetCount] = await db.select({ c: count() }).from(eval_set);
  const [evalRunsCount] = await db.select({ c: count() }).from(eval_runs);
  const [scrapedCount] = await db.select({ c: count() }).from(scraped_pages);
  const [cronCount] = await db
    .select({ c: count() })
    .from(cron_jobs)
    .where(eq(cron_jobs.active, true));
  const [auditCount] = await db.select({ c: count() }).from(audit_log);

  return [
    '*Memory state*',
    `facts: ${factsActive?.c ?? 0} active / ${factsContradicted?.c ?? 0} contradicted`,
    `skills: ${skillsActive?.c ?? 0} active / ${skillsAll?.c ?? 0} total`,
    `scraped_pages cache: ${scrapedCount?.c ?? 0}`,
    `eval_set: ${evalSetCount?.c ?? 0} cases  /  eval_runs: ${evalRunsCount?.c ?? 0}`,
    `scheduled cron_jobs: ${cronCount?.c ?? 0}`,
    `audit_log entries: ${auditCount?.c ?? 0}`,
  ].join('\n');
}

export async function renderQueue(queue: Queue<EnrichedEvent>): Promise<string> {
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'failed',
    'completed',
  );
  const lines = [
    '*Queue state*',
    `waiting: ${counts.waiting ?? 0}`,
    `active:  ${counts.active ?? 0}`,
    `delayed: ${counts.delayed ?? 0}`,
    `failed:  ${counts.failed ?? 0}`,
    `completed (retained): ${counts.completed ?? 0}`,
  ];

  if ((counts.failed ?? 0) > 0) {
    const failed = await queue.getJobs(['failed'], 0, 5);
    lines.push('', '*Recent failed:*');
    for (const j of failed) {
      const reason = j.failedReason ?? 'unknown';
      lines.push(`• \`${j.id ?? '?'}\` — ${reason.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

export async function renderErrors(hours: number): Promise<string> {
  if (!isMemoryEnabled()) return '_DB not configured_';
  const db = getDb();
  const since = hoursAgo(hours);
  const rows = await db
    .select({
      turn_id: trajectories.turn_id,
      user_id: trajectories.user_id,
      channel_id: trajectories.channel_id,
      halt_reason: trajectories.halt_reason,
      created_at: trajectories.created_at,
    })
    .from(trajectories)
    .where(
      and(gte(trajectories.created_at, since), eq(trajectories.outcome, 'errored')),
    )
    .orderBy(desc(trajectories.created_at))
    .limit(20);

  if (rows.length === 0) return `_no errored turns in last ${hours}h_ 🎉`;

  const lines = [`*Errored turns — last ${hours}h*`];
  for (const r of rows) {
    lines.push(
      `• \`${r.turn_id.slice(0, 8)}\` <@${r.user_id}> in <#${r.channel_id}> — ${r.halt_reason ?? '?'} at ${r.created_at.toISOString()}`,
    );
  }
  lines.push('', `_Use \`/audit <turn_id>\` for full chain._`);
  return lines.join('\n');
}

function parseHours(arg: string | undefined): number {
  if (!arg) return 24;
  const n = parseInt(arg, 10);
  if (Number.isNaN(n) || n <= 0) return 24;
  return Math.min(n, 24 * 30); // cap at 30d
}

export async function dispatchAdmin(
  queue: Queue<EnrichedEvent>,
  rawArgs: string,
): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] || SECTIONS.overview;
  const arg1 = parts[1];

  try {
    switch (sub) {
      case SECTIONS.overview:
        return await renderOverview(queue);
      case SECTIONS.users:
        return await renderUsers(parseHours(arg1));
      case SECTIONS.tools:
        return await renderTools(parseHours(arg1));
      case SECTIONS.cost:
        return await renderCost(parseHours(arg1));
      case SECTIONS.memory:
        return await renderMemory();
      case SECTIONS.queue:
        return await renderQueue(queue);
      case SECTIONS.errors:
        return await renderErrors(parseHours(arg1));
      case SECTIONS.help:
        return HELP;
      default:
        return `Unknown subcommand: \`${sub}\`\n\n${HELP}`;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, sub }, 'admin_dispatch_failed');
    return `❌ admin error: ${(err as Error).message}`;
  }
}
