import { logger } from '../logger.js';

interface ScheduledJob {
  cancel: () => void;
}

function msUntilNext(hourUtc: number, minuteUtc: number, dayOfWeek?: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (dayOfWeek !== undefined) {
    const daysAhead = (dayOfWeek - target.getUTCDay() + 7) % 7;
    target.setUTCDate(target.getUTCDate() + daysAhead);
  }
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + (dayOfWeek !== undefined ? 7 : 1));
  }
  return target.getTime() - now.getTime();
}

export function scheduleDailyUtc(
  hourUtc: number,
  minuteUtc: number,
  fn: () => Promise<void>,
  label = 'daily_job',
): ScheduledJob {
  let timer: NodeJS.Timeout | null = null;
  const tick = (): void => {
    void fn().catch((err: unknown) =>
      logger.warn({ err: (err as Error).message, job: label }, 'cron_job_failed'),
    );
    timer = setTimeout(tick, msUntilNext(hourUtc, minuteUtc));
  };
  timer = setTimeout(tick, msUntilNext(hourUtc, minuteUtc));
  logger.info(
    { job: label, ms_until_first_run: msUntilNext(hourUtc, minuteUtc), hourUtc, minuteUtc },
    'cron_scheduled',
  );
  return {
    cancel: (): void => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * dayOfWeek: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 */
export function scheduleWeeklyUtc(
  dayOfWeek: number,
  hourUtc: number,
  minuteUtc: number,
  fn: () => Promise<void>,
  label = 'weekly_job',
): ScheduledJob {
  let timer: NodeJS.Timeout | null = null;
  const tick = (): void => {
    void fn().catch((err: unknown) =>
      logger.warn({ err: (err as Error).message, job: label }, 'cron_job_failed'),
    );
    timer = setTimeout(tick, msUntilNext(hourUtc, minuteUtc, dayOfWeek));
  };
  timer = setTimeout(tick, msUntilNext(hourUtc, minuteUtc, dayOfWeek));
  logger.info(
    {
      job: label,
      ms_until_first_run: msUntilNext(hourUtc, minuteUtc, dayOfWeek),
      dayOfWeek,
      hourUtc,
      minuteUtc,
    },
    'cron_scheduled',
  );
  return {
    cancel: (): void => {
      if (timer) clearTimeout(timer);
    },
  };
}
