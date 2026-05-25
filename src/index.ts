process.on('uncaughtException', (err: Error) => {
  console.error('UNCAUGHT', err.message, err.stack);
});
process.on('unhandledRejection', (err: unknown) => {
  console.error('UNHANDLED', err);
});

import { initTelemetry, shutdownTelemetry } from './telemetry.js';
initTelemetry();

import type { App } from '@slack/bolt';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { loadAcl } from './config/acl.js';
import { env } from './config/env.js';
import { runDailyAuditVerify } from './jobs/audit-verify.js';
import { scheduleDailyUtc, scheduleWeeklyUtc } from './jobs/cron.js';
import { runDailyBackup } from './jobs/db-backup.js';
import { startDecayJob, stopDecayJob } from './jobs/decay.js';
import { startHeartbeatRunner, stopHeartbeatRunner } from './jobs/heartbeat.js';
import { startRoutineRunner, stopRoutineRunner } from './jobs/routine-runner.js';
import { runWeeklyEvalCuration } from './jobs/eval-curation.js';
import { runDailyEvalReplay } from './jobs/eval-replay.js';
import { startOpsWatchdog, stopOpsWatchdog } from './jobs/ops-watchdog.js';
import { startSchedulerRunner, stopSchedulerRunner } from './jobs/scheduler-runner.js';
import { exportYesterday } from './jobs/trajectory-export.js';
import { flushPending } from './lifecycle.js';
import { logger } from './logger.js';
import { closeMcpServers, initMcpServers } from './mcp/manager.js';
import { startMetricsServer, stopMetricsServer } from './metrics.js';
import { createTurnsQueue, createTurnsWorker } from './queue/turns.js';
import { createRedis } from './redis.js';
import { buildApp } from './slack/app.js';
import type { EnrichedEvent } from './slack/types.js';
// Side-effect import — registers tools at module load
import './tools/bootstrap.js';
import { listAll as listAllTools } from './tools/registry.js';
import { makeTurnHandler } from './worker/turn-handler.js';

const slackConfigured =
  !!env.SLACK_BOT_TOKEN && !!env.SLACK_APP_TOKEN && !!env.SLACK_SIGNING_SECRET;
const redisConfigured = !!env.REDIS_URL;

interface Shutdownable {
  close: () => Promise<void> | void;
}

async function main(): Promise<void> {
  // M11.3: metrics server (always on — holds event loop alive too)
  startMetricsServer();

  // MCP servers (config/mcp.yaml). Failures logged, don't block boot.
  await initMcpServers();

  const all = listAllTools();
  logger.info(
    {
      node_env: env.NODE_ENV,
      llm_model: env.LLM_MODEL,
      builtin_tools: all.filter((t) => !t.name.startsWith('mcp_')).map((t) => t.name),
      mcp_tools: all.filter((t) => t.name.startsWith('mcp_')).map((t) => t.name),
    },
    'superbot starting',
  );

  const shutdownables: Shutdownable[] = [
    { close: () => stopMetricsServer() },
    { close: () => shutdownTelemetry() },
    { close: () => closeMcpServers() },
  ];
  let slackApp: App | undefined;
  let worker: Worker<EnrichedEvent> | undefined;

  if (slackConfigured && redisConfigured) {
    const redis: Redis = createRedis();
    const workerRedis: Redis = createRedis();
    const acl = loadAcl();
    const queue: Queue<EnrichedEvent> = createTurnsQueue(redis);
    shutdownables.push({ close: () => queue.close() });
    shutdownables.push({ close: () => redis.quit().then(() => undefined) });

    slackApp = await buildApp({ redis, queue, acl });

    worker = createTurnsWorker(workerRedis, makeTurnHandler(workerRedis));
    shutdownables.push({ close: () => worker!.close() });
    shutdownables.push({ close: () => workerRedis.quit().then(() => undefined) });

    await slackApp.start();
    logger.info('slack socket mode connected — listening for events');

    startDecayJob();
    shutdownables.push({ close: () => stopDecayJob() });

    const trajCron = scheduleDailyUtc(
      2,
      30,
      async () => {
        const r = await exportYesterday();
        logger.info(r, 'trajectory_export_run');
      },
      'trajectory_export',
    );
    shutdownables.push({ close: () => trajCron.cancel() });

    const curationCron = scheduleWeeklyUtc(
      0,
      9,
      0,
      runWeeklyEvalCuration,
      'eval_curation',
    );
    shutdownables.push({ close: () => curationCron.cancel() });

    const replayCron = scheduleDailyUtc(
      4,
      0,
      async () => {
        await runDailyEvalReplay(workerRedis);
      },
      'eval_replay',
    );
    shutdownables.push({ close: () => replayCron.cancel() });

    const auditCron = scheduleDailyUtc(5, 0, runDailyAuditVerify, 'audit_verify');
    shutdownables.push({ close: () => auditCron.cancel() });

    const backupCron = scheduleDailyUtc(4, 30, runDailyBackup, 'db_backup');
    shutdownables.push({ close: () => backupCron.cancel() });

    startSchedulerRunner(queue);
    shutdownables.push({ close: () => stopSchedulerRunner() });

    startOpsWatchdog(queue);
    shutdownables.push({ close: () => stopOpsWatchdog() });

    startHeartbeatRunner(queue);
    shutdownables.push({ close: () => stopHeartbeatRunner() });

    startRoutineRunner(queue);
    shutdownables.push({ close: () => stopRoutineRunner() });
  } else {
    logger.warn(
      {
        slack_configured: slackConfigured,
        redis_configured: redisConfigured,
      },
      'slack or redis not configured — running in skeleton mode (no event handling)',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown requested');

    if (slackApp) {
      try {
        await slackApp.stop();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'slack stop failed');
      }
    }

    await flushPending(10_000);

    for (const s of shutdownables.reverse()) {
      try {
        await s.close();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'shutdownable close failed');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'fatal startup error',
  );
  process.exit(1);
});
