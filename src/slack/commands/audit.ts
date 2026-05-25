import type { App } from '@slack/bolt';
import { getAuditChainForTurn } from '../../audit.js';

export function registerAuditCommand(app: App): void {
  app.command('/audit', async ({ ack, body, respond }) => {
    await ack();
    const turn_id = (body.text ?? '').trim();
    if (!turn_id) {
      await respond({ text: 'Usage: `/audit <turn_id>`', response_type: 'ephemeral' });
      return;
    }
    const chain = await getAuditChainForTurn(turn_id);
    if (chain.length === 0) {
      await respond({
        text: `No audit entries for turn \`${turn_id}\``,
        response_type: 'ephemeral',
      });
      return;
    }
    const lines = chain.map(
      (r) =>
        `[${r.ts.toISOString()}] ${r.actor}:${r.action}  ${r.self_hash.slice(0, 12)}`,
    );
    await respond({
      text: `*Audit chain for \`${turn_id}\` (${chain.length} entries):*\n\`\`\`${lines.join('\n')}\`\`\``,
      response_type: 'ephemeral',
    });
  });
}
