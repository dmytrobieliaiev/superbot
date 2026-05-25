import type { App } from '@slack/bolt';

export const HELP_TEXT = `*superbot commands:*
\`/ask <question>\` — ask the agent
\`/memory show\` — list facts I remember about you
\`/forget <topic>\` — soft-delete matching facts
\`/remember <text>\` — pin a fact (no decay)
\`/skill list\` — show learned skills
\`/skill delete <id>\` — remove a skill
\`/audit <turn_id>\` — show hash-chained log for a turn
\`/backfill [channel] [days]\` — index Slack history into memory (admin)
\`/heartbeat add|list|pause|resume|delete <id|args>\` — proactive scans
\`/routines\` — list & manage approved routines
\`/admin\` — admin dashboard (gated)
\`/help\` — this message

Tag me with \`@superbot\` in any channel where I'm invited, or DM me.`;

export function registerHelp(app: App): void {
  app.command('/help', async ({ ack, respond }) => {
    await ack();
    await respond({ text: HELP_TEXT, response_type: 'ephemeral' });
  });
}
