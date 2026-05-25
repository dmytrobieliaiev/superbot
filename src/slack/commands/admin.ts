import type { App } from '@slack/bolt';
import type { Queue } from 'bullmq';
import { dispatchAdmin, isAdmin } from '../admin.js';
import type { EnrichedEvent } from '../types.js';

export function registerAdminCommand(app: App, queue: Queue<EnrichedEvent>): void {
  app.command('/admin', async ({ ack, body, respond }) => {
    await ack();
    if (!isAdmin(body.user_id)) {
      await respond({
        text: '❌ admin access required (your user id is not in ADMIN_USER_IDS)',
        response_type: 'ephemeral',
      });
      return;
    }
    const text = await dispatchAdmin(queue, body.text ?? '');
    await respond({ text, response_type: 'ephemeral' });
  });
}
