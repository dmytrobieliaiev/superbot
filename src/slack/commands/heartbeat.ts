import type { App } from '@slack/bolt';
import { and, eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { heartbeats } from '../../db/schema.js';

export function registerHeartbeatCommand(app: App): void {
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
        await respond({
          text: 'No heartbeats. Add: `/heartbeat add <cadence> <scan prompt>` (cadence: hourly|daily|weekly)',
          response_type: 'ephemeral',
        });
        return;
      }
      const lines = rows.map(
        (h) =>
          `• \`${h.id.slice(0, 8)}\` ${h.enabled ? '🟢' : '⏸️'} [${h.cadence}] next=${h.next_run_at.toISOString()} — ${h.scan_prompt.slice(0, 80)}`,
      );
      await respond({
        text: `*Your heartbeats:*\n${lines.join('\n')}`,
        response_type: 'ephemeral',
      });
      return;
    }
    if (sub === 'add') {
      const cadence = args[1];
      const prompt = args.slice(2).join(' ').trim();
      if (!cadence || !['hourly', 'daily', 'weekly'].includes(cadence) || !prompt) {
        await respond({
          text: 'Usage: `/heartbeat add hourly|daily|weekly <scan prompt>`',
          response_type: 'ephemeral',
        });
        return;
      }
      const offsetMs =
        cadence === 'hourly'
          ? 60 * 60_000
          : cadence === 'weekly'
            ? 7 * 24 * 60 * 60_000
            : 24 * 60 * 60_000;
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
        text: `🫀 heartbeat added \`${inserted[0]?.id?.slice(0, 8) ?? '?'}\` — first scan in ${
          cadence === 'hourly' ? '1h' : cadence === 'weekly' ? '7d' : '24h'
        }`,
        response_type: 'ephemeral',
      });
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const id = args[1];
      if (!id) {
        await respond({
          text: `Usage: \`/heartbeat ${sub} <id>\``,
          response_type: 'ephemeral',
        });
        return;
      }
      await db
        .update(heartbeats)
        .set({ enabled: sub === 'resume' })
        .where(and(eq(heartbeats.user_id, body.user_id), eq(heartbeats.id, id)));
      await respond({
        text: `${sub === 'resume' ? '▶️' : '⏸️'} \`${id}\``,
        response_type: 'ephemeral',
      });
      return;
    }
    if (sub === 'delete') {
      const id = args[1];
      if (!id) {
        await respond({ text: 'Usage: `/heartbeat delete <id>`', response_type: 'ephemeral' });
        return;
      }
      await db
        .delete(heartbeats)
        .where(and(eq(heartbeats.user_id, body.user_id), eq(heartbeats.id, id)));
      await respond({ text: `🗑️ deleted \`${id}\``, response_type: 'ephemeral' });
      return;
    }
    await respond({
      text: 'Usage: `/heartbeat add|list|pause|resume|delete`',
      response_type: 'ephemeral',
    });
  });
}
