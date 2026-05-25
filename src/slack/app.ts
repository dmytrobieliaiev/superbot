import { App, LogLevel } from '@slack/bolt';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { checkAcl, logDenial } from '../acl/gate.js';
import type { Acl } from '../config/acl.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { registerEvalActions } from './actions/eval.js';
import { registerRoutineActions } from './actions/routine.js';
import { registerToolModalActions } from './actions/tool-modal.js';
import { registerAdminCommand } from './commands/admin.js';
import { registerAuditCommand } from './commands/audit.js';
import { registerBackfillCommand } from './commands/backfill.js';
import { registerHeartbeatCommand } from './commands/heartbeat.js';
import { registerHelp } from './commands/help.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerRoutinesCommand } from './commands/routines.js';
import { registerSkillCommands } from './commands/skill.js';
import { enrich } from './enrich.js';
import { normalizeCommandPayload, normalizeMessageEvent } from './normalize.js';
import { markEventSeen } from '../queue/dedupe.js';
import { enqueueTurn } from '../queue/turns.js';
import { handleReactionOnBotMessage, type ReactionEvent } from './reactions.js';
import type { EnrichedEvent, InboundEvent } from './types.js';

export interface ReceiverDeps {
  redis: Redis;
  queue: Queue<EnrichedEvent>;
  acl: Acl;
}

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

  // Event routing —————————————————————————————————————————————————————————
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

  app.event('reaction_added', async ({ event }) => {
    await handleReactionOnBotMessage(
      event as unknown as ReactionEvent,
      botUserId,
      deps.redis,
    );
  });

  // /ask uses the local `handle` closure — keep inline.
  app.command('/ask', async ({ ack, body }) => {
    await ack();
    await handle(normalizeCommandPayload(body));
  });

  // Slash commands ————————————————————————————————————————————————————————
  registerHelp(app);
  registerMemoryCommands(app);
  registerSkillCommands(app);
  registerAuditCommand(app);
  registerBackfillCommand(app);
  registerHeartbeatCommand(app);
  registerRoutinesCommand(app);
  registerAdminCommand(app, deps.queue);

  // Block-action handlers ————————————————————————————————————————————————
  registerEvalActions(app);
  registerRoutineActions(app);
  registerToolModalActions(app, deps.redis);

  return app;
}
