import type { App } from '@slack/bolt';
import { and, eq } from 'drizzle-orm';
import { logAudit } from '../../audit.js';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { routines } from '../../db/schema.js';
import { nextCronFire, parseCron } from '../../jobs/cron-parse.js';
import { logger } from '../../logger.js';

export function registerRoutineActions(app: App): void {
  app.action('routine_approve', async ({ ack, body, action, respond }) => {
    await ack();
    const id = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id;
    if (!id || !user_id || !isMemoryEnabled()) {
      await respond({
        text: 'routine_approve: missing id or DB',
        replace_original: false,
      });
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
      await respond({
        text: 'routine_reject: missing id or DB',
        replace_original: false,
      });
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
}
