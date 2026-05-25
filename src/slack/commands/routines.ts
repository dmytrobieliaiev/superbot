import type { App } from '@slack/bolt';
import { and, eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { routines } from '../../db/schema.js';

export function registerRoutinesCommand(app: App): void {
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
        await respond({
          text: `Usage: \`/routines ${sub} <id>\``,
          response_type: 'ephemeral',
        });
        return;
      }
      const newStatus = sub === 'resume' ? 'approved' : sub === 'pause' ? 'paused' : 'revoked';
      await db
        .update(routines)
        .set({ status: newStatus })
        .where(and(eq(routines.user_id, body.user_id), eq(routines.id, id)));
      await respond({
        text: `routine \`${id}\` → ${newStatus}`,
        response_type: 'ephemeral',
      });
      return;
    }
    await respond({
      text: 'Usage: `/routines list|pause|resume|revoke <id>`',
      response_type: 'ephemeral',
    });
  });
}
