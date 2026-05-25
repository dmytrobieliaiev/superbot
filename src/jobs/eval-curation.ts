import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { logger } from '../logger.js';
import { slackClient } from '../slack/client.js';

const SAMPLE_SIZE = 20;
const WEEK_DAYS = 7;

interface CandidateRow {
  turn_id: string;
  user_id: string;
  channel_id: string;
  full_log: { user_text?: string; assistant_text?: string };
}

export async function runWeeklyEvalCuration(): Promise<void> {
  if (!isMemoryEnabled()) return;
  if (!env.MAINTAINER_USER_ID) {
    logger.warn('MAINTAINER_USER_ID not set — skipping eval curation');
    return;
  }
  const db = getDb();
  const since = new Date(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1000);

  const candidates = (await db.execute(sql`
    SELECT turn_id, user_id, channel_id, full_log
    FROM trajectories
    WHERE outcome = 'done' AND created_at >= ${since}
    ORDER BY random()
    LIMIT ${SAMPLE_SIZE}
  `)) as unknown as CandidateRow[];

  if (candidates.length === 0) {
    logger.info('eval_curation: no candidates this week');
    return;
  }

  const client = slackClient();
  const dm = await client.conversations.open({ users: env.MAINTAINER_USER_ID });
  const channel = dm.channel?.id;
  if (!channel) {
    logger.warn('eval_curation: failed to open DM');
    return;
  }

  await client.chat.postMessage({
    channel,
    text: `🧪 Weekly eval curation — ${candidates.length} candidates from past week. 👍 to approve, 👎 to skip.`,
  });

  for (const c of candidates) {
    const log = c.full_log ?? {};
    const userText = (log.user_text ?? '').slice(0, 300);
    const assistantText = (log.assistant_text ?? '').slice(0, 700);
    await client.chat.postMessage({
      channel,
      text: `Eval candidate ${c.turn_id}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Turn:* \`${c.turn_id}\`` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*User:*\n${userText}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Assistant:*\n${assistantText}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '👍 Approve' },
              style: 'primary',
              value: c.turn_id,
              action_id: 'eval_approve',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '👎 Skip' },
              value: c.turn_id,
              action_id: 'eval_skip',
            },
          ],
        },
      ],
    });
  }
  logger.info({ count: candidates.length }, 'eval_curation_dm_sent');
}
