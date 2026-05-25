import { and, asc, eq, gte } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { cron_jobs } from '../../db/schema.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

type SchedulerAction = 'schedule' | 'list' | 'cancel';

interface SchedulerArgs {
  action: SchedulerAction;
  when?: string; // ISO-8601 datetime
  prompt?: string;
  id?: string;
}

const MAX_PER_USER = 50;

export const scheduler: ToolSpec<SchedulerArgs> = {
  name: 'scheduler',
  description:
    'Schedule a one-off action to fire later as if the user had just messaged the bot. Actions: schedule, list, cancel.',
  params_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['schedule', 'list', 'cancel'] },
      when: { type: 'string', description: 'ISO-8601 datetime (UTC). Required for schedule.' },
      prompt: { type: 'string', description: 'What the agent should do when fired. Required for schedule.' },
      id: { type: 'string', description: 'Job id. Required for cancel.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isMemoryEnabled()) {
      return err('DB not configured — scheduler unavailable', 'no_db', started);
    }
    const db = getDb();

    try {
      if (args.action === 'schedule') {
        if (!args.when || !args.prompt) {
          return err('schedule requires when + prompt', 'bad_args', started);
        }
        const fireAt = new Date(args.when);
        if (Number.isNaN(fireAt.getTime())) {
          return err('invalid when (ISO-8601 expected)', 'bad_args', started);
        }
        if (fireAt.getTime() < Date.now() + 30 * 1000) {
          return err('schedule must be at least 30s in the future', 'bad_args', started);
        }

        const existing = await db
          .select({ id: cron_jobs.id })
          .from(cron_jobs)
          .where(and(eq(cron_jobs.owner_user_id, ctx.user_id), eq(cron_jobs.active, true)));
        if (existing.length >= MAX_PER_USER) {
          return err(
            `you already have ${existing.length} active jobs (max ${MAX_PER_USER})`,
            'limit',
            started,
          );
        }

        const inserted = await db
          .insert(cron_jobs)
          .values({
            owner_user_id: ctx.user_id,
            owner_channel_id: ctx.channel_id,
            fire_at: fireAt,
            action_prompt: args.prompt,
          })
          .returning({ id: cron_jobs.id });

        const id = inserted[0]?.id;
        return ok(
          `📅 scheduled \`${id ?? '?'}\` for ${fireAt.toISOString()}: ${args.prompt}`,
          started,
        );
      }

      if (args.action === 'list') {
        const rows = await db
          .select()
          .from(cron_jobs)
          .where(
            and(
              eq(cron_jobs.owner_user_id, ctx.user_id),
              eq(cron_jobs.active, true),
              gte(cron_jobs.fire_at, new Date()),
            ),
          )
          .orderBy(asc(cron_jobs.fire_at));

        if (rows.length === 0) return ok('no scheduled jobs', started);
        const lines = rows
          .slice(0, 30)
          .map(
            (j) =>
              `• \`${j.id.slice(0, 8)}\` at ${j.fire_at.toISOString()} — ${j.action_prompt.slice(0, 100)}`,
          );
        return ok(`*Your scheduled jobs (${rows.length}):*\n${lines.join('\n')}`, started);
      }

      if (args.action === 'cancel') {
        if (!args.id) return err('cancel requires id', 'bad_args', started);
        const updated = await db
          .update(cron_jobs)
          .set({ active: false })
          .where(and(eq(cron_jobs.id, args.id), eq(cron_jobs.owner_user_id, ctx.user_id)))
          .returning({ id: cron_jobs.id });
        if (updated.length === 0) {
          return err(`job ${args.id} not found or not owned by you`, 'not_found', started);
        }
        return ok(`🗑️ cancelled \`${args.id}\``, started);
      }

      return err(`unknown action: ${args.action as string}`, 'bad_args', started);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'scheduler_failed');
      return err(`scheduler error: ${(e as Error).message}`, (e as Error).message, started);
    }
  },
};

function ok(content: string, started: number): ToolResult {
  return {
    status: 'ok',
    content,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}

function err(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
