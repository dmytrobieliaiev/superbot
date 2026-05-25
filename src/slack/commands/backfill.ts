import type { App } from '@slack/bolt';
import { logAudit } from '../../audit.js';
import { runSlackBackfill } from '../../jobs/slack-backfill.js';
import { logger } from '../../logger.js';
import { isAdmin } from '../admin.js';

export function registerBackfillCommand(app: App): void {
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
}
