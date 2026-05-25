import type { App } from '@slack/bolt';
import { eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../../db/index.js';
import { eval_set, trajectories } from '../../db/schema.js';
import { logger } from '../../logger.js';

export function registerEvalActions(app: App): void {
  app.action('eval_approve', async ({ ack, body, action, respond }) => {
    await ack();
    const turn_id = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
    if (!turn_id || !isMemoryEnabled()) {
      await respond({
        text: 'eval_approve: missing turn_id or DB',
        replace_original: false,
      });
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
      await respond({
        text: `✅ Added \`${turn_id}\` to eval_set`,
        replace_original: false,
      });
      logger.info({ turn_id, approved_by: user_id }, 'eval_set_added');
    } catch (err) {
      logger.error({ err: (err as Error).message, turn_id }, 'eval_approve failed');
      await respond({
        text: `❌ failed: ${(err as Error).message}`,
        replace_original: false,
      });
    }
  });

  app.action('eval_skip', async ({ ack, action, respond }) => {
    await ack();
    const turn_id = (action as { value?: string }).value;
    await respond({ text: `⏭️ Skipped \`${turn_id ?? '?'}\``, replace_original: false });
  });
}
