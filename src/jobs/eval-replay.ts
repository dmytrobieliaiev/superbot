import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { eval_runs, eval_set } from '../db/schema.js';
import { judgeResponse } from '../llm/judge.js';
import { PROMPT_VERSION, renderSystemPrompt } from '../llm/prompt.js';
import { logger } from '../logger.js';
import { slackClient } from '../slack/client.js';
import { runToolLoop } from '../worker/tool-loop.js';

const REGRESSION_THRESHOLD = 0.3;

export async function runDailyEvalReplay(redis: Redis): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();

  const cases = await db.select().from(eval_set);
  if (cases.length === 0) {
    logger.info('eval_replay: empty eval_set');
    return;
  }

  let total = 0;
  let scored = 0;
  for (const c of cases) {
    try {
      // Replay through current agent (no memory context — clean room)
      const replay = await runToolLoop({
        redis,
        ctx: {
          turn_id: randomUUID(),
          user_id: 'eval',
          channel_id: 'eval',
          channel_type: 'eval',
        },
        systemPrompt: renderSystemPrompt({ user: 'eval' }),
        contextBlocks: [],
        userText: c.user_input,
      });

      const score = await judgeResponse(c.user_input, replay.text, c.expected_outcome);

      await db.insert(eval_runs).values({
        eval_set_id: c.id,
        helpful: score.helpful,
        correct: score.correct,
        grounded: score.grounded,
        avg_score: score.avg_score,
        judge_note: score.note,
        replay_text: replay.text,
        replay_outcome: replay.halt_reason === 'final_text' ? 'done' : 'halted',
        prompt_version: PROMPT_VERSION,
      });

      total += score.avg_score;
      scored++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, eval_id: c.id },
        'eval_case_failed',
      );
    }
  }

  if (scored === 0) {
    logger.warn('eval_replay: 0 cases scored');
    return;
  }
  const avg = total / scored;

  // Trailing 7-day baseline (excluding today)
  const baselineRows = (await db.execute(sql`
    SELECT AVG(avg_score)::real AS avg
    FROM eval_runs
    WHERE ran_at >= now() - interval '8 days' AND ran_at < now() - interval '1 day'
  `)) as unknown as Array<{ avg: number | null }>;
  const baseline = baselineRows[0]?.avg ?? null;

  const delta = baseline !== null ? avg - baseline : null;
  logger.info(
    { cases: scored, avg, baseline, delta },
    'eval_replay_done',
  );

  if (env.AGENT_OPS_CHANNEL) {
    const client = slackClient();
    const summary = baseline !== null
      ? `📊 Daily eval: avg=${avg.toFixed(2)} (baseline=${baseline.toFixed(2)}, Δ=${(delta ?? 0).toFixed(2)}) across ${scored} cases`
      : `📊 Daily eval: avg=${avg.toFixed(2)} across ${scored} cases (no baseline yet)`;
    await client.chat.postMessage({ channel: env.AGENT_OPS_CHANNEL, text: summary });

    if (delta !== null && delta < -REGRESSION_THRESHOLD) {
      await client.chat.postMessage({
        channel: env.AGENT_OPS_CHANNEL,
        text: `🚨 Eval regression: avg dropped ${Math.abs(delta).toFixed(2)} vs trailing 7-day baseline (threshold ${REGRESSION_THRESHOLD})`,
      });
    }
  }
}
