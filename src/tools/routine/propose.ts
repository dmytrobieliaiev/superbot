import { getDb, isMemoryEnabled } from '../../db/index.js';
import { routines } from '../../db/schema.js';
import { toolSetHash } from '../../jobs/heartbeat.js';
import { parseCron } from '../../jobs/cron-parse.js';
import { logger } from '../../logger.js';
import { slackClient } from '../../slack/client.js';
import { listAll } from '../registry.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface ProposeArgs {
  name: string;
  description?: string;
  /** Cron expression (5 fields, UTC). E.g. '0 9 * * 1' = Mon 09:00 UTC. */
  cron: string;
  /** The action prompt that will run as a turn when the routine fires. */
  plan_prompt: string;
}

function dmBlocks(routineId: string, name: string, cron: string, plan: string): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Proposed routine: ${name}*\n\`${cron}\` UTC` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: '```' + plan.slice(0, 2500) + '```' } },
    {
      type: 'actions',
      block_id: `routine_${routineId}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'routine_approve',
          value: routineId,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: 'routine_reject',
          value: routineId,
        },
      ],
    },
  ];
}

export const routine_propose: ToolSpec<ProposeArgs> = {
  name: 'routine_propose',
  description:
    'Propose a recurring routine to the user (cron-triggered). User must approve via Slack button before it runs. Use when you detect a repeating workflow worth automating.',
  params_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', maxLength: 1000 },
      cron: { type: 'string', description: '5-field cron expression in UTC' },
      plan_prompt: { type: 'string', minLength: 10, maxLength: 4000 },
    },
    required: ['name', 'cron', 'plan_prompt'],
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    if (!isMemoryEnabled()) {
      return err('memory disabled — routines require DB', 'no_db', started);
    }
    try {
      parseCron(args.cron);
    } catch (e) {
      return err(`invalid cron: ${(e as Error).message}`, 'bad_cron', started);
    }

    const hash = toolSetHash(listAll().map((t) => t.name));
    const db = getDb();
    try {
      const inserted = await db
        .insert(routines)
        .values({
          user_id: ctx.user_id,
          channel_id: ctx.channel_id,
          name: args.name,
          description: args.description ?? null,
          trigger_kind: 'cron',
          trigger_spec: { cron: args.cron },
          plan_prompt: args.plan_prompt,
          tool_set_hash: hash,
          status: 'pending',
        })
        .returning({ id: routines.id });
      const id = inserted[0]?.id;
      if (!id) {
        return err('insert returned no id', 'db_insert', started);
      }

      // DM the proposer with approval buttons.
      try {
        const open = await slackClient().conversations.open({ users: ctx.user_id });
        const dm = open.channel?.id;
        if (dm) {
          await slackClient().chat.postMessage({
            channel: dm,
            text: `Routine proposed: ${args.name}`,
            blocks: dmBlocks(id, args.name, args.cron, args.plan_prompt) as unknown as never,
          });
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'routine_propose_dm_failed');
      }

      return {
        status: 'ok',
        content: `routine proposed (id=${id.slice(0, 8)}). Awaiting user approval via DM.`,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (e) {
      return err(`routine_propose error: ${(e as Error).message}`, (e as Error).message, started);
    }
  },
};

function err(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
