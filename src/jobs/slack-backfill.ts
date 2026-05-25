import { getDb, getRawClient, isMemoryEnabled } from '../db/index.js';
import { message_chunks } from '../db/schema.js';
import { embed } from '../llm/embed.js';
import { logger } from '../logger.js';
import { chunkText } from '../memory/chunk.js';
import { slackClient } from '../slack/client.js';

const HISTORY_PAGE_LIMIT = 200;
const HISTORY_THROTTLE_MS = 1300; // tier 3 ≈ 50 req/min — leave headroom
const REPLIES_PAGE_LIMIT = 200;

export interface BackfillOpts {
  /** Channel ID (C…/G…/D…). If omitted, all channels bot is member of. */
  channel?: string;
  /** Oldest Slack ts (seconds, string). If omitted, days controls window. */
  oldest_ts?: string;
  /** Lookback days when oldest_ts not set. Default 30. */
  days?: number;
  /** Include private channels bot is in. Default true. */
  include_private?: boolean;
  /** Include DMs (im) + group DMs (mpim). Default false. */
  include_ims?: boolean;
  /** Embed message chunks during backfill. Default true. */
  embed?: boolean;
}

export interface BackfillResult {
  channels: number;
  messages_seen: number;
  messages_inserted: number;
  threads_walked: number;
  errors: number;
  elapsed_ms: number;
}

interface SlackMsg {
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  reply_count?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function listTargetChannels(
  channel: string | undefined,
  include_private: boolean,
  include_ims: boolean,
): Promise<string[]> {
  if (channel) return [channel];
  const types: string[] = ['public_channel'];
  if (include_private) types.push('private_channel');
  if (include_ims) types.push('im', 'mpim');
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await slackClient().users.conversations({
      types: types.join(','),
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    for (const c of r.channels ?? []) {
      if (c.id) out.push(c.id);
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function insertMessage(
  channelId: string,
  msg: SlackMsg,
  doEmbed: boolean,
): Promise<boolean> {
  if (!msg.ts || !msg.user || !msg.text) return false;
  if (msg.subtype && msg.subtype !== 'thread_broadcast' && msg.subtype !== 'file_share') {
    return false;
  }
  const role = msg.bot_id ? 'assistant' : 'user';
  const ts = new Date(Number(msg.ts.split('.')[0]) * 1000);
  const sql = getRawClient();
  // ON CONFLICT DO NOTHING on partial unique index (channel_id, external_ts)
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO messages (
      turn_id, channel_id, user_id, thread_ts, role, content, ts, external_ts, source
    )
    VALUES (
      NULL, ${channelId}, ${msg.user}, ${msg.thread_ts ?? null}, ${role},
      ${msg.text}, ${ts}, ${msg.ts}, 'backfill'
    )
    ON CONFLICT (channel_id, external_ts) WHERE external_ts IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const row = inserted[0];
  if (!row) return false;

  if (doEmbed) {
    try {
      const chunks = chunkText(msg.text);
      if (chunks.length > 0) {
        const embeddings = await embed(chunks);
        const db = getDb();
        await db.insert(message_chunks).values(
          chunks.map((c, i) => ({
            message_id: row.id,
            chunk_index: i,
            content: c,
            embedding: embeddings[i] ?? null,
          })),
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, message_id: row.id },
        'backfill_embed_failed',
      );
    }
  }
  return true;
}

async function walkThread(
  channelId: string,
  parentTs: string,
  doEmbed: boolean,
  res: BackfillResult,
): Promise<void> {
  let cursor: string | undefined;
  do {
    await sleep(HISTORY_THROTTLE_MS);
    try {
      const r = await slackClient().conversations.replies({
        channel: channelId,
        ts: parentTs,
        limit: REPLIES_PAGE_LIMIT,
        cursor,
      });
      for (const m of (r.messages ?? []) as SlackMsg[]) {
        // Skip parent — already inserted by caller
        if (m.ts === parentTs) continue;
        res.messages_seen++;
        try {
          const ok = await insertMessage(channelId, m, doEmbed);
          if (ok) res.messages_inserted++;
        } catch (err) {
          res.errors++;
          logger.warn(
            { err: (err as Error).message, channel: channelId, ts: m.ts },
            'backfill_insert_failed',
          );
        }
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } catch (err) {
      res.errors++;
      logger.warn(
        { err: (err as Error).message, channel: channelId, parent: parentTs },
        'backfill_replies_failed',
      );
      break;
    }
  } while (cursor);
}

async function backfillChannel(
  channelId: string,
  oldest: string | undefined,
  doEmbed: boolean,
  res: BackfillResult,
): Promise<void> {
  let cursor: string | undefined;
  do {
    await sleep(HISTORY_THROTTLE_MS);
    try {
      const r = await slackClient().conversations.history({
        channel: channelId,
        limit: HISTORY_PAGE_LIMIT,
        cursor,
        oldest,
      });
      for (const m of (r.messages ?? []) as SlackMsg[]) {
        res.messages_seen++;
        try {
          const ok = await insertMessage(channelId, m, doEmbed);
          if (ok) res.messages_inserted++;
        } catch (err) {
          res.errors++;
          logger.warn(
            { err: (err as Error).message, channel: channelId, ts: m.ts },
            'backfill_insert_failed',
          );
        }
        // If parent w/ replies, walk thread
        if (m.ts && m.reply_count && m.reply_count > 0) {
          res.threads_walked++;
          await walkThread(channelId, m.ts, doEmbed, res);
        }
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } catch (err) {
      res.errors++;
      logger.warn(
        { err: (err as Error).message, channel: channelId },
        'backfill_history_failed',
      );
      break;
    }
  } while (cursor);
}

export async function runSlackBackfill(opts: BackfillOpts = {}): Promise<BackfillResult> {
  if (!isMemoryEnabled()) {
    throw new Error('memory disabled — backfill requires DB');
  }
  const started = Date.now();
  const days = opts.days ?? 30;
  const oldest = opts.oldest_ts ?? String(Math.floor((Date.now() - days * 86400_000) / 1000));
  const doEmbed = opts.embed ?? true;

  const channels = await listTargetChannels(
    opts.channel,
    opts.include_private ?? true,
    opts.include_ims ?? false,
  );

  logger.info(
    { channels: channels.length, oldest, days, embed: doEmbed },
    'slack_backfill_start',
  );

  const res: BackfillResult = {
    channels: channels.length,
    messages_seen: 0,
    messages_inserted: 0,
    threads_walked: 0,
    errors: 0,
    elapsed_ms: 0,
  };

  for (const c of channels) {
    await backfillChannel(c, oldest, doEmbed, res);
  }

  res.elapsed_ms = Date.now() - started;
  logger.info(res, 'slack_backfill_done');
  return res;
}
