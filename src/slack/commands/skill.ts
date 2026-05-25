import type { App } from '@slack/bolt';
import { logAudit } from '../../audit.js';
import { deleteSkill, listSkills } from '../../memory/skills.js';

export function registerSkillCommands(app: App): void {
  app.command('/skill', async ({ ack, body, respond }) => {
    await ack();
    const args = (body.text ?? '').trim().split(/\s+/);
    const subcmd = args[0] ?? 'list';
    if (subcmd === 'list' || subcmd === '') {
      const list = await listSkills();
      if (list.length === 0) {
        await respond({ text: '🪞 No skills learned yet.', response_type: 'ephemeral' });
        return;
      }
      const lines = list
        .slice(0, 30)
        .map(
          (s) =>
            `• \`${s.id.slice(0, 8)}\` *${s.name}* — ${s.trigger_desc} (${s.success_count ?? 0}✓ ${s.fail_count ?? 0}✗)`,
        );
      await respond({
        text: `*Learned skills (${list.length} total):*\n${lines.join('\n')}`,
        response_type: 'ephemeral',
      });
      return;
    }
    if (subcmd === 'delete') {
      const id = args[1];
      if (!id) {
        await respond({ text: 'Usage: `/skill delete <id>`', response_type: 'ephemeral' });
        return;
      }
      const ok = await deleteSkill(id);
      await respond({
        text: ok ? `🗑️ Deleted skill \`${id}\`` : `Skill \`${id}\` not found`,
        response_type: 'ephemeral',
      });
      if (ok) {
        await logAudit({
          actor: 'user',
          action: 'skill_delete',
          payload: { user_id: body.user_id, skill_id: id },
        });
      }
      return;
    }
    await respond({
      text: 'Usage: `/skill list` or `/skill delete <id>`',
      response_type: 'ephemeral',
    });
  });
}
