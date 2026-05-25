import type { App } from '@slack/bolt';
import { logAudit } from '../../audit.js';
import { forgetFacts, getFactsForUser, rememberPinned } from '../../memory/governance.js';

export function registerMemoryCommands(app: App): void {
  app.command('/memory', async ({ ack, body, respond }) => {
    await ack();
    const arg = (body.text ?? '').trim();
    if (arg && arg !== 'show') {
      await respond({ text: 'Usage: `/memory show`', response_type: 'ephemeral' });
      return;
    }
    const rows = await getFactsForUser(body.user_id);
    if (rows.length === 0) {
      await respond({
        text: '🪞 I have no facts about you stored yet.',
        response_type: 'ephemeral',
      });
      return;
    }
    const lines = rows
      .slice(0, 30)
      .map(
        (f) =>
          `• \`${f.id.slice(0, 8)}\` *${f.subject}* | ${f.predicate} | ${f.object} (conf=${f.confidence.toFixed(2)})`,
      );
    await respond({
      text: `*What I remember about you (${rows.length} total, showing top 30):*\n${lines.join('\n')}`,
      response_type: 'ephemeral',
    });
    await logAudit({
      actor: 'user',
      action: 'memory_show',
      payload: { user_id: body.user_id, count: rows.length },
    });
  });

  app.command('/forget', async ({ ack, body, respond }) => {
    await ack();
    const topic = (body.text ?? '').trim();
    if (!topic) {
      await respond({ text: 'Usage: `/forget <topic>`', response_type: 'ephemeral' });
      return;
    }
    const r = await forgetFacts(body.user_id, topic);
    await respond({
      text: `🗑️ Forgot ${r.count} fact(s) matching "${topic}".`,
      response_type: 'ephemeral',
    });
    await logAudit({
      actor: 'user',
      action: 'forget_facts',
      payload: { user_id: body.user_id, topic, count: r.count },
    });
  });

  app.command('/remember', async ({ ack, body, respond }) => {
    await ack();
    const factText = (body.text ?? '').trim();
    if (!factText) {
      await respond({ text: 'Usage: `/remember <fact>`', response_type: 'ephemeral' });
      return;
    }
    try {
      await rememberPinned(body.user_id, factText);
      await respond({
        text: `📌 Pinned: _${factText}_`,
        response_type: 'ephemeral',
      });
      await logAudit({
        actor: 'user',
        action: 'remember_pinned',
        payload: { user_id: body.user_id, fact: factText },
      });
    } catch (err) {
      await respond({
        text: `❌ failed: ${(err as Error).message}`,
        response_type: 'ephemeral',
      });
    }
  });
}
