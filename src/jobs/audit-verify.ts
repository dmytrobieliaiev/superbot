import { verifyChain } from '../audit.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { slackClient } from '../slack/client.js';

export async function runDailyAuditVerify(): Promise<void> {
  const r = await verifyChain();
  if (!r.ok) {
    logger.error(
      { broken_at: r.broken_at, rows_checked: r.rows_checked },
      'audit_chain_broken',
    );
    if (env.AGENT_OPS_CHANNEL) {
      try {
        await slackClient().chat.postMessage({
          channel: env.AGENT_OPS_CHANNEL,
          text: `🚨 audit_log chain integrity broken at row \`${r.broken_at}\` after checking ${r.rows_checked} rows`,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'audit_alert_post_failed');
      }
    }
  } else {
    logger.info({ rows_checked: r.rows_checked }, 'audit_chain_verified');
  }
}
