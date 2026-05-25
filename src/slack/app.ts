import { App, LogLevel } from '@slack/bolt';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { checkAcl, logDenial } from '../acl/gate.js';
import { getAuditChainForTurn, logAudit } from '../audit.js';
import type { Acl } from '../config/acl.js';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { eval_set, trajectories } from '../db/schema.js';
import { runSlackBackfill } from '../jobs/slack-backfill.js';
import { logger } from '../logger.js';
import { dispatchAdmin, isAdmin } from './admin.js';
import { heartbeats, routines } from '../db/schema.js';
import { nextCronFire, parseCron } from '../jobs/cron-parse.js';
import { handleReactionOnBotMessage, type ReactionEvent } from './reactions.js';
import { forgetFacts, getFactsForUser, rememberPinned } from '../memory/governance.js';
import { deleteSkill, listSkills } from '../memory/skills.js';
import { markEventSeen } from '../queue/dedupe.js';
import { enqueueTurn } from '../queue/turns.js';
import { enrich } from './enrich.js';
import { normalizeCommandPayload, normalizeMessageEvent } from './normalize.js';
import type { EnrichedEvent, InboundEvent } from './types.js';

export interface ReceiverDeps {
  redis: Redis;
  queue: Queue<EnrichedEvent>;
  acl: Acl;
}

const HELP_TEXT = `*superbot commands:*
\`/ask <question>\` — ask the agent
\`/memory show\` — list facts I remember about you
\`/forget <topic>\` — soft-delete matching facts
\`/remember <text>\` — pin a fact (no decay)
\`/skill list\` — show learned skills
\`/skill delete <id>\` — remove a skill
\`/audit <turn_id>\` — show hash-chained log for a turn
\`/backfill [channel] [days]\` — index Slack history into memory (admin)
\`/heartbeat add|list|pause|resume|delete <id|args>\` — proactive scans
\`/routines\` — list & manage approved routines
\`/admin\` — admin dashboard (gated)
\`/help\` — this message

Tag me with \`@superbot\` in any channel where I'm invited, or DM me.`;

export async function buildApp(deps: ReceiverDeps): Promise<App> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN || !env.SLACK_SIGNING_SECRET) {
    throw new Error('Slack tokens missing — see docs/slack-app-setup.md');
  }

  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    socketMode: true,
    logLevel: env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  let botUserIdLoaded: string;
  try {
    const auth = await app.client.auth.test();
    if (!auth.user_id) throw new Error('auth.test returned no user_id');
    botUserIdLoaded = auth.user_id;
    logger.info({ bot_user_id: botUserIdLoaded, team: auth.team }, 'slack auth ok');
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'slack auth.test failed — cannot reliably filter own messages',
    );
    throw err;
  }
  const botUserId: string = botUserIdLoaded;

  const isOwnMessage = (userId: string): boolean => userId === botUserId;

  const handle = async (evt: InboundEvent | null): Promise<void> => {
    if (!evt) return;
    if (isOwnMessage(evt.user_id)) return;

    const isNew = await markEventSeen(deps.redis, evt.event_id);
    if (!isNew) {
      logger.debug({ event_id: evt.event_id }, 'dedup_hit');
      return;
    }

    const acl = checkAcl(deps.acl, evt);
    if (!acl.allowed) {
      logDenial(evt, acl);
      return;
    }

    // Instant ack: 👀 reaction on user's message so they see the bot received it
    // before memory/LLM work starts. Fire-and-forget — never block enqueue on this.
    void app.client.reactions
      .add({ channel: evt.channel_id, name: 'eyes', timestamp: evt.ts })
      .catch((err: unknown) =>
        logger.debug(
          { err: (err as Error).message, channel: evt.channel_id, ts: evt.ts },
          'eyes_ack_failed',
        ),
      );

    try {
      const enriched = await enrich(app.client, evt, deps.redis);
      await enqueueTurn(deps.queue, enriched);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, event_id: evt.event_id },
        'enrich+enqueue failed',
      );
    }
  };

  app.event('app_mention', async ({ body }) => {
    await handle(normalizeMessageEvent(body as Parameters<typeof normalizeMessageEvent>[0]));
  });

  app.message(async ({ body, message }) => {
    const m = message as { channel_type?: string; thread_ts?: string };

    // DMs always handled
    if (m.channel_type === 'im') {
      await handle(normalizeMessageEvent(body as Parameters<typeof normalizeMessageEvent>[0]));
      return;
    }

    // Channel thread follow-up: if bot is active in this thread, handle even
    // without @mention. TTL controlled by THREAD_FOLLOWUP_TTL_SEC env var.
    if (m.thread_ts && env.THREAD_FOLLOWUP_TTL_SEC > 0) {
      const active = await deps.redis.exists(`thread_active:${m.thread_ts}`);
      if (active) {
        await handle(
          normalizeMessageEvent(body as Parameters<typeof normalizeMessageEvent>[0]),
        );
      }
    }
  });

  // Reactions on bot's own messages — feedback + follow-up triggers
  app.event('reaction_added', async ({ event }) => {
    await handleReactionOnBotMessage(
      event as unknown as ReactionEvent,
      botUserId,
      deps.redis,
    );
  });

  // /ask → route through LLM loop
  app.command('/ask', async ({ ack, body }) => {
    await ack();
    await handle(normalizeCommandPayload(body));
  });

  // /help → static
  app.command('/help', async ({ ack, respond }) => {
    await ack();
    await respond({ text: HELP_TEXT, response_type: 'ephemeral' });
  });

  // M10.3: governance commands
  app.command('/memory', async ({ ack, body, respond }) => {
    await ack();
    const arg = (body.text ?? '').trim();
    if (arg && arg !== 'show') {
      await respond({ text: 'Usage: `/memory show`', response_type: 'ephemeral' });
      return;
    }
    const rows = await getFactsForUser(body.user_id);
    if (rows.length === 0) {
      await respond({
        text: '🪞 I have no facts about you stored yet.',
        response_type: 'ephemeral',
      });
      return;
    }
    const lines = rows
      .slice(0, 30)
      .map(
        (f) =>
          `• \`${f.id.slice(0, 8)}\` *${f.subject}* | ${f.predicate} | ${f.object} (conf=${f.confidence.toFixed(2)})`,
      );
    await respond({
      text: `*What I remember about you (${rows.length} total, showing top 30):*\n${lines.join('\n')}`,
      response_type: 'ephemeral',
    });
    await logAudit({
      actor: 'user',
      action: 'memory_show',
      payload: { user_id: body.user_id, count: rows.length },
    });
  });

  app.command('/forget', async ({ ack, body, respond }) => {
    await ack();
    const topic = (body.text ?? '').trim();
    if (!topic) {
      await respond({ text: 'Usage: `/forget <topic>`', response_type: 'ephemeral' });
      return;
    }
    const r = await forgetFacts(body.user_id, topic);
    await respond({
      text: `🗑️ Forgot ${r.count} fact(s) matching "${topic}".`,
      response_type: 'ephemeral',
    });
    await logAudit({
      actor: 'user',
      action: 'forget_facts',
      payload: { user_id: body.user_id, topic, count: r.count },
    });
  });

  app.command('/backfill', async ({ ack, body, respond }) => {
    await ack();
    if (!isAdmin(body.user_id)) {
      await respond({ text: '❌ admin only', response_type: 'ephemeral' });
      return;
    }
    const args = (body.text ?? '').trim().split(/\s+/).filter(Boolean);
    let channel: string | undefined;
    let days = 30;
    for (const a of args) {
      if (/^C[A-Z0-9]+$|^G[A-Z0-9]+$|^D[A-Z0-9]+$/.test(a)) channel = a;
      else if (/^\d+$/.test(a)) days = parseInt(a, 10);
    }
    await respond({
      text: `⏳ backfill starting — channel=${channel ?? 'ALL'}, days=${days}. I'll DM you when done.`,
      response_type: 'ephemeral',
    });
    void (async (): Promise<void> => {
      try {
        const opts: Parameters<typeof runSlackBackfill>[0] = { days };
        if (channel) opts.channel = channel;
        const r = await runSlackBackfill(opts);
        await logAudit({
          actor: 'user',
          action: 'slack_backfill',
          payload: { user_id: body.user_id, channel, days, ...r },
        });
        await app.client.chat.postMessage({
          channel: body.user_id,
          text: `✅ backfill done: ${r.messages_inserted} inserted / ${r.messages_seen} seen across ${r.channels} channel(s), ${r.threads_walked} threads, ${r.errors} errors, ${(r.elapsed_ms / 1000).toFixed(1)}s`,
        });
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'slack_backfill_failed');
        await app.client.chat
          .postMessage({
            channel: body.user_id,
            text: `❌ backfill failed: ${(err as Error).message}`,
          })
          .catch(() => undefined);
      }
    })();
  });

  app.command('/remember', async ({ ack, body, respond }) => {
    await ack();
    const factText = (body.text ?? '').trim();
    if (!factText) {
      await respond({ text: 'Usage: `/remember <fact>`', response_type: 'ephemeral' });
      return;
    }
    try {
      await rememberPinned(body.user_id, factText);
      await respond({
        text: `📌 Pinned: _${factText}_`,
        response_type: 'ephemeral',
      });
      await logAudit({
        actor: 'user',
        action: 'remember_pinned',
        payload: { user_id: body.user_id, fact: factText },
      });
    } catch (err) {
      await respond({
        text: `❌ failed: ${(err as Error).message}`,
        response_type: 'ephemeral',
      });
    }
  });

  // M10.4: skill commands
  app.command('/skill', async ({ ack, body, respond }) => {
    await ack();
    const args = (body.text ?? '').trim().split(/\s+/);
    const subcmd = args[0] ?? 'list';
    if (subcmd === 'list' || subcmd === '') {
      const list = await listSkills();
      if (list.length === 0) {
        await respond({ text: '🪞 No skills learned yet.', response_type: 'ephemeral' });
        return;
      }
      const lines = list
        .slice(0, 30)
        .map(
          (s) =>
            `• \`${s.id.slice(0, 8)}\` *${s.name}* — ${s.trigger_desc} (${s.success_count ?? 0}✓ ${s.fail_count ?? 0}✗)`,
        );
      await respond({
        text: `*Learned skills (${list.length} total):*\n${lines.join('\n')}`,
        response_type: 'ephemeral',
      });
      return;
    }
    if (subcmd === 'delete') {
      const id = args[1];
      if (!id) {
        await respond({ text: 'Usage: `/skill delete <id>`', response_type: 'ephemeral' });
        return;
      }
      const ok = await deleteSkill(id);
      await respond({
        text: ok ? `🗑️ Deleted skill \`${id}\`` : `Skill \`${id}\` not found`,
        response_type: 'ephemeral',
      });
      if (ok) {
        await logAudit({
          actor: 'user',
          action: 'skill_delete',
          payload: { user_id: body.user_id, skill_id: id },
        });
      }
      return;
    }
    await respond({
      text: 'Usage: `/skill list` or `/skill delete <id>`',
      response_type: 'ephemeral',
    });
  });

  // Admin dashboard — gated by ADMIN_USER_IDS env
  app.command('/admin', async ({ ack, body, respond }) => {
    await ack();
    if (!isAdmin(body.user_id)) {
      await respond({
        text: '❌ admin access required (your user id is not in ADMIN_USER_IDS)',
        response_type: 'ephemeral',
      });
      return;
    }
    const text = await dispatchAdmin(deps.queue, body.text ?? '');
    await respond({ text, response_type: 'ephemeral' });
  });

  // M10.5: /audit
  app.command('/audit', async ({ ack, body, respond }) => {
    await ack();
    const turn_id = (body.text ?? '').trim();
    if (!turn_id) {
      await respond({ text: 'Usage: `/audit <turn_id>`', response_type: 'ephemeral' });
      return;
    }
    const chain = await getAuditChainForTurn(turn_id);
    if (chain.length === 0) {
      await respond({
        text: `No audit entries for turn \`${turn_id}\``,
        response_type: 'ephemeral',
      });
      return;
    }
    const lines = chain.map(
      (r) =>
        `[${r.ts.toISOString()}] ${r.actor}:${r.action}  ${r.self_hash.slice(0, 12)}`,
    );
    await respond({
      text: `*Audit chain for \`${turn_id}\` (${chain.length} entries):*\n\`\`\`${lines.join('\n')}\`\`\``,
      response_type: 'ephemeral',
    });
  });

  // M7.3: eval curation action handlers
  app.action('eval_approve', async ({ ack, body, action, respond }) => {
    await ack();
    const turn_id = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
    if (!turn_id || !isMemoryEnabled()) {
      await respond({ text: 'eval_approve: missing turn_id or DB', replace_original: false });
      return;
    }
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(trajectories)
        .where(eq(trajectories.turn_id, turn_id))
        .limit(1);
      const t = rows[0];
      if (!t) {
        await respond({ text: `trajectory ${turn_id} not found`, replace_original: false });
        return;
      }
      const log = t.full_log as { user_text?: string };
      await db
        .insert(eval_set)
        .values({
          trajectory_id: turn_id,
          user_input: log.user_text ?? '',
          expected_outcome: t.outcome,
          approved_by: user_id,
        })
        .onConflictDoNothing();
      await respond({ text: `✅ Added \`${turn_id}\` to eval_set`, replace_original: false });
      logger.info({ turn_id, approved_by: user_id }, 'eval_set_added');
    } catch (err) {
      logger.error({ err: (err as Error).message, turn_id }, 'eval_approve failed');
      await respond({ text: `❌ failed: ${(err as Error).message}`, replace_original: false });
    }
  });

  app.action('eval_skip', async ({ ack, action, respond }) => {
    await ack();
    const turn_id = (action as { value?: string }).value;
    await respond({ text: `⏭️ Skipped \`${turn_id ?? '?'}\``, replace_original: false });
  });

  // M5.6: destructive op confirmation modal action handlers
  app.action('tool_confirm', async ({ ack, action, body, respond }) => {
    await ack();
    const token = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
    if (!token) {
      await respond({ text: 'tool_confirm: missing token', replace_original: false });
      return;
    }
    const { markConfirmed } = await import('./modal.js');
    await markConfirmed(deps.redis, token);
    await logAudit({
      actor: 'user',
      action: 'tool_confirm',
      payload: { token, user_id },
    });
    await respond({
      text: `✅ Confirmed. Re-mention the bot to retry the action.`,
      replace_original: false,
    });
  });

  app.command('/heartbeat', async ({ ack, body, respond }) => {
    await ack();
    if (!isMemoryEnabled()) {
      await respond({ text: 'memory disabled', response_type: 'ephemeral' });
      return;
    }
    const args = (body.text ?? '').trim().split(/\s+/);
    const sub = args[0] ?? 'list';
    const db = getDb();
    if (sub === 'list' || sub === '') {
      const rows = await db
        .select()
        .from(heartbeats)
        .where(eq(heartbeats.user_id, body.user_id));
      if (rows.length === 0) {
        await respond({ text: 'No heartbeats. Add: `/heartbeat add <cadence> <scan prompt>` (cadence: hourly|daily|weekly)', response_type: 'ephemeral' });
        return;
      }
      const lines = rows.map(
        (h) =>
          `• \`${h.id.slice(0, 8)}\` ${h.enabled ? '🟢' : '⏸️'} [${h.cadence}] next=${h.next_run_at.toISOString()} — ${h.scan_prompt.slice(0, 80)}`,
      );
      await respond({ text: `*Your heartbeats:*\n${lines.join('\n')}`, response_type: 'ephemeral' });
      return;
    }
    if (sub === 'add') {
      const cadence = args[1];
      const prompt = args.slice(2).join(' ').trim();
      if (!cadence || !['hourly', 'daily', 'weekly'].includes(cadence) || !prompt) {
        await respond({ text: 'Usage: `/heartbeat add hourly|daily|weekly <scan prompt>`', response_type: 'ephemeral' });
        return;
      }
      const offsetMs = cadence === 'hourly' ? 60 * 60_000 : cadence === 'weekly' ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
      const inserted = await db
        .insert(heartbeats)
        .values({
          user_id: body.user_id,
          cadence,
          scan_prompt: prompt,
          next_run_at: new Date(Date.now() + offsetMs),
        })
        .returning({ id: heartbeats.id });
      await respond({
        text: `🫀 heartbeat added \`${inserted[0]?.id?.slice(0, 8) ?? '?'}\` — first scan in ${cadence === 'hourly' ? '1h' : cadence === 'weekly' ? '7d' : '24h'}`,
        response_type: 'ephemeral',
      });
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const id = args[1];
      if (!id) {
        await respond({ text: `Usage: \`/heartbeat ${sub} <id>\``, response_type: 'ephemeral' });
        return;
      }
      await db
        .update(heartbeats)
        .set({ enabled: sub === 'resume' })
        .where(and(eq(heartbeats.user_id, body.user_id), eq(heartbeats.id, id)));
      await respond({ text: `${sub === 'resume' ? '▶️' : '⏸️'} \`${id}\``, response_type: 'ephemeral' });
      return;
    }
    if (sub === 'delete') {
      const id = args[1];
      if (!id) {
        await respond({ text: 'Usage: `/heartbeat delete <id>`', response_type: 'ephemeral' });
        return;
      }
      await db.delete(heartbeats).where(and(eq(heartbeats.user_id, body.user_id), eq(heartbeats.id, id)));
      await respond({ text: `🗑️ deleted \`${id}\``, response_type: 'ephemeral' });
      return;
    }
    await respond({ text: 'Usage: `/heartbeat add|list|pause|resume|delete`', response_type: 'ephemeral' });
  });

  app.command('/routines', async ({ ack, body, respond }) => {
    await ack();
    if (!isMemoryEnabled()) {
      await respond({ text: 'memory disabled', response_type: 'ephemeral' });
      return;
    }
    const args = (body.text ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = args[0] ?? 'list';
    const db = getDb();
    if (sub === 'list' || sub === '') {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.user_id, body.user_id));
      if (rows.length === 0) {
        await respond({ text: 'No routines yet.', response_type: 'ephemeral' });
        return;
      }
      const lines = rows.map((r) => {
        const spec = r.trigger_spec as { cron?: string };
        const cron = spec?.cron ?? '?';
        const next = r.next_run_at ? r.next_run_at.toISOString() : '—';
        return `• \`${r.id.slice(0, 8)}\` [${r.status}] *${r.name}* — \`${cron}\` UTC next=${next} fails=${r.consecutive_failures}`;
      });
      await respond({ text: `*Routines:*\n${lines.join('\n')}`, response_type: 'ephemeral' });
      return;
    }
    if (sub === 'pause' || sub === 'resume' || sub === 'revoke') {
      const id = args[1];
      if (!id) {
        await respond({ text: `Usage: \`/routines ${sub} <id>\``, response_type: 'ephemeral' });
        return;
      }
      const newStatus = sub === 'resume' ? 'approved' : sub === 'pause' ? 'paused' : 'revoked';
      await db
        .update(routines)
        .set({ status: newStatus })
        .where(and(eq(routines.user_id, body.user_id), eq(routines.id, id)));
      await respond({ text: `routine \`${id}\` → ${newStatus}`, response_type: 'ephemeral' });
      return;
    }
    await respond({ text: 'Usage: `/routines list|pause|resume|revoke <id>`', response_type: 'ephemeral' });
  });

  app.action('routine_approve', async ({ ack, body, action, respond }) => {
    await ack();
    const id = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id;
    if (!id || !user_id || !isMemoryEnabled()) {
      await respond({ text: 'routine_approve: missing id or DB', replace_original: false });
      return;
    }
    try {
      const db = getDb();
      const rows = await db.select().from(routines).where(eq(routines.id, id)).limit(1);
      const r = rows[0];
      if (!r) {
        await respond({ text: `routine ${id} not found`, replace_original: false });
        return;
      }
      if (r.user_id !== user_id) {
        await respond({ text: '❌ only the proposer can approve', replace_original: false });
        return;
      }
      const spec = r.trigger_spec as { cron?: string };
      let next: Date | null = null;
      if (spec?.cron) {
        try {
          parseCron(spec.cron);
          next = nextCronFire(spec.cron);
        } catch {
          /* leave null */
        }
      }
      await db
        .update(routines)
        .set({
          status: 'approved',
          approved_at: new Date(),
          approved_by: user_id,
          next_run_at: next,
        })
        .where(eq(routines.id, id));
      await logAudit({
        actor: 'user',
        action: 'routine_approve',
        payload: { routine_id: id, user_id, next_run_at: next?.toISOString() },
      });
      await respond({
        text: `✅ Approved *${r.name}* — first run ${next ? next.toISOString() : 'unscheduled'}`,
        replace_original: true,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, id }, 'routine_approve_failed');
      await respond({ text: `❌ ${(err as Error).message}`, replace_original: false });
    }
  });

  app.action('routine_reject', async ({ ack, body, action, respond }) => {
    await ack();
    const id = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id;
    if (!id || !user_id || !isMemoryEnabled()) {
      await respond({ text: 'routine_reject: missing id or DB', replace_original: false });
      return;
    }
    try {
      const db = getDb();
      await db
        .update(routines)
        .set({ status: 'revoked' })
        .where(and(eq(routines.id, id), eq(routines.user_id, user_id)));
      await logAudit({
        actor: 'user',
        action: 'routine_reject',
        payload: { routine_id: id, user_id },
      });
      await respond({ text: '✖️ Rejected', replace_original: true });
    } catch (err) {
      await respond({ text: `❌ ${(err as Error).message}`, replace_original: false });
    }
  });

  app.action('tool_cancel', async ({ ack, action, body, respond }) => {
    await ack();
    const token = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
    await logAudit({
      actor: 'user',
      action: 'tool_cancel',
      payload: { token, user_id },
    });
    await respond({
      text: `✖️ Cancelled.`,
      replace_original: false,
    });
  });

  return app;
}
