import { logger } from '../logger.js';
import { parseInlineBlocks } from './blocks.js';
import { canvasDeepLink, createSharedCanvas } from './canvas.js';
import { slackClient } from './client.js';
import { uploadBufferToSlack } from './upload.js';
import type { EnrichedEvent } from './types.js';

// Stream short answers inline; long answers ship as a .md file attached to
// the same thread, with a brief summary in the visible message.
const INLINE_SOFT_LIMIT = 3_500; // mid-stream cap — safe across mrkdwn/emoji
const INLINE_HARD_LIMIT = 12_000; // chat.update absolute ceiling we trust
const FILE_THRESHOLD_CHARS = 4_000; // beyond this at finalize → .md upload
const CANVAS_THRESHOLD_CHARS = 60_000; // extreme outputs → canvas fallback
const CANVAS_PREVIEW_CHARS = 800;
const UPDATE_THROTTLE_MS = 600;

/**
 * One-shot reply. Used for error paths and skeleton (non-streaming) flows.
 * Long output is truncated; for streaming + file overflow, use ProgressiveReply.
 */
export async function postReply(evt: EnrichedEvent, text: string): Promise<void> {
  const client = slackClient();
  const safe =
    text.length > INLINE_HARD_LIMIT
      ? text.slice(0, INLINE_HARD_LIMIT) + '\n\n…[truncated]'
      : text;

  const threadTs = evt.thread_ts ?? evt.ts;
  const params: Parameters<typeof client.chat.postMessage>[0] = {
    channel: evt.channel_id,
    text: safe,
    thread_ts: threadTs,
  };

  try {
    const r = await client.chat.postMessage(params);
    if (r.ts) {
      await client.reactions
        .add({ channel: evt.channel_id, name: 'robot_face', timestamp: r.ts })
        .catch(() => undefined);
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, channel: evt.channel_id },
      'postReply failed',
    );
  }
}

/** Summarize a long reply for the inline message that accompanies the file. */
function summarize(full: string): string {
  // Take first paragraph or first 500 chars, whichever shorter.
  const firstPara = full.split(/\n{2,}/)[0] ?? full;
  const head = firstPara.length > 500 ? firstPara.slice(0, 500) + '…' : firstPara;
  return head;
}

/**
 * Stateful Slack reply.
 *  - Streams short answers progressively (single message, chat.update).
 *  - Long answers (>FILE_THRESHOLD_CHARS at finalize) ship as a .md file
 *    attached to the same thread, plus a one-line inline summary.
 */
export class ProgressiveReply {
  private msg_ts: string | undefined;
  private channel: string;
  private thread_ts: string | undefined;
  private user_msg_ts: string;
  private lastUpdate = 0;
  private inflight = false;
  private finalized = false;
  /** Set once chat.update returns msg_too_long — stops further interim spam. */
  private updateBlocked = false;

  constructor(evt: EnrichedEvent) {
    this.channel = evt.channel_id;
    this.thread_ts = evt.thread_ts ?? evt.ts;
    this.user_msg_ts = evt.ts;
  }

  getThreadTs(): string | undefined {
    return this.thread_ts;
  }

  getMessageTs(): string | undefined {
    return this.msg_ts;
  }

  /**
   * Throttled streaming update. Truncates to INLINE_SOFT_LIMIT mid-stream so
   * we never trip msg_too_long. finalize() decides inline vs file.
   */
  async update(
    text: string,
    opts: { force?: boolean; blocks?: ReturnType<typeof parseInlineBlocks>['blocks'] } = {},
  ): Promise<void> {
    if (this.finalized) return;
    if (this.updateBlocked && !opts.force) return;
    if (!opts.force) {
      if (this.inflight) return;
      if (Date.now() - this.lastUpdate < UPDATE_THROTTLE_MS) return;
    }
    this.inflight = true;
    this.lastUpdate = Date.now();

    const client = slackClient();
    const tooLong = text.length > INLINE_SOFT_LIMIT;
    const safe = tooLong
      ? text.slice(0, INLINE_SOFT_LIMIT) + '\n\n…[streaming — full reply at end]'
      : text;
    const body = safe || '…';

    try {
      if (!this.msg_ts) {
        const params: Parameters<typeof client.chat.postMessage>[0] = {
          channel: this.channel,
          text: body,
        };
        if (this.thread_ts) params.thread_ts = this.thread_ts;
        if (opts.blocks && opts.blocks.length > 0) {
          (params as { blocks?: unknown }).blocks = opts.blocks;
        }
        const r = await client.chat.postMessage(params);
        if (typeof r.ts === 'string') this.msg_ts = r.ts;
      } else {
        const params: Parameters<typeof client.chat.update>[0] = {
          channel: this.channel,
          ts: this.msg_ts,
          text: body,
        };
        if (opts.blocks && opts.blocks.length > 0) {
          (params as { blocks?: unknown }).blocks = opts.blocks;
        }
        await client.chat.update(params);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('msg_too_long')) {
        this.updateBlocked = true;
        logger.warn(
          { channel: this.channel, text_len: text.length },
          'progressive_reply_overflowed — interim updates suppressed; file at finalize',
        );
      } else {
        logger.warn({ err: msg, channel: this.channel }, 'progressive_reply_update_failed');
      }
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Final write. Routing:
   *   short (≤ FILE_THRESHOLD)       → inline chat.update with full text
   *   long  (> FILE_THRESHOLD)       → upload .md file + summary message
   *   extreme (> CANVAS_THRESHOLD)   → canvas link (if available) + summary
   */
  async finalize(
    text: string,
    opts: { useCanvasIfLong?: boolean; title?: string } = {},
  ): Promise<void> {
    if (this.finalized) return;

    const parsed = parseInlineBlocks(text);
    if (parsed.malformed) {
      logger.warn({ channel: this.channel }, 'inline_blocks_malformed');
    }
    const cleanText = parsed.text;
    const title = opts.title ?? 'Agent reply';

    // Extreme — canvas
    if (
      opts.useCanvasIfLong &&
      cleanText.length > CANVAS_THRESHOLD_CHARS
    ) {
      const canvas = await createSharedCanvas(title, cleanText, this.channel);
      if (canvas.ok && canvas.canvas_id) {
        const link = canvasDeepLink(canvas.canvas_id);
        const preview = cleanText.slice(0, CANVAS_PREVIEW_CHARS);
        const summary = `📎 *Long output → <${link}|open canvas>*\n\n${preview}…`;
        await this.update(summary, { force: true });
        await this.attachBlocks(parsed.blocks);
        this.finalized = true;
        await this.addReactji();
        return;
      }
      logger.warn(
        { err: canvas.error, channel: this.channel },
        'canvas_overflow_failed_fallback_to_file',
      );
      // fall through to file path
    }

    // Long — .md file upload
    if (cleanText.length > FILE_THRESHOLD_CHARS) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `reply-${stamp}.md`;
      const summary =
        `📄 *Full reply attached* (${cleanText.length.toLocaleString()} chars)\n\n${summarize(cleanText)}`;
      // Post the summary first so the bot's message exists, THEN attach file
      // in the same thread for cohesive presentation.
      await this.update(summary, { force: true });
      try {
        const buf = Buffer.from(cleanText, 'utf-8');
        const up = await uploadBufferToSlack(buf, {
          channel: this.channel,
          ...(this.thread_ts ? { thread_ts: this.thread_ts } : {}),
          filename,
          title,
        });
        if (!up.ok) {
          logger.warn(
            { err: up.error, channel: this.channel },
            'file_upload_failed_inline_fallback',
          );
          // Fallback: blast the full text via chat.update (will truncate at hard limit)
          await this.update(cleanText.slice(0, INLINE_HARD_LIMIT), { force: true });
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, channel: this.channel },
          'file_upload_threw_inline_fallback',
        );
        await this.update(cleanText.slice(0, INLINE_HARD_LIMIT), { force: true });
      }
      await this.attachBlocks(parsed.blocks);
      this.finalized = true;
      await this.addReactji();
      return;
    }

    // Short — inline
    await this.update(cleanText, { force: true, blocks: parsed.blocks });
    this.finalized = true;
    await this.addReactji();
  }

  private async attachBlocks(
    blocks: ReturnType<typeof parseInlineBlocks>['blocks'],
  ): Promise<void> {
    if (!blocks || blocks.length === 0) return;
    try {
      const client = slackClient();
      const params: Parameters<typeof client.chat.postMessage>[0] = {
        channel: this.channel,
        text: 'rich follow-up',
        blocks: blocks as unknown as never,
      };
      if (this.thread_ts) params.thread_ts = this.thread_ts;
      await client.chat.postMessage(params);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'progressive_reply_blocks_failed',
      );
    }
  }

  private async addReactji(): Promise<void> {
    const client = slackClient();
    void client.reactions
      .remove({ channel: this.channel, name: 'eyes', timestamp: this.user_msg_ts })
      .catch(() => undefined);
    if (!this.msg_ts) return;
    try {
      await client.reactions.add({
        channel: this.channel,
        name: 'robot_face',
        timestamp: this.msg_ts,
      });
    } catch {
      /* ignore — message may be too new or rate-limited */
    }
  }
}
