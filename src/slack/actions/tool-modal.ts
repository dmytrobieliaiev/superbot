import type { App } from '@slack/bolt';
import type { Redis } from 'ioredis';
import { logAudit } from '../../audit.js';

export function registerToolModalActions(app: App, redis: Redis): void {
  app.action('tool_confirm', async ({ ack, action, body, respond }) => {
    await ack();
    const token = (action as { value?: string }).value;
    const user_id = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
    if (!token) {
      await respond({ text: 'tool_confirm: missing token', replace_original: false });
      return;
    }
    const { markConfirmed } = await import('../modal.js');
    await markConfirmed(redis, token);
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
}
