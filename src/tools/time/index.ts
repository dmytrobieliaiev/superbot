import type { ToolResult, ToolSpec } from '../types.js';

interface TimeArgs {
  timezone?: string;
  format?: 'iso' | 'human' | 'epoch_ms';
}

const DEFAULT_TZ = 'UTC';

export const time_now: ToolSpec<TimeArgs> = {
  name: 'time_now',
  description:
    'Return current date and time. Use whenever the agent needs to know "now" — never guess. Supports IANA timezone (e.g. "Europe/Kyiv", "America/New_York") and format (iso | human | epoch_ms).',
  params_schema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name. Defaults to UTC.',
      },
      format: {
        type: 'string',
        enum: ['iso', 'human', 'epoch_ms'],
        default: 'iso',
      },
    },
    additionalProperties: false,
  },
  cost_estimate: () => 0,
  async execute(args): Promise<ToolResult> {
    const started = Date.now();
    const tz = args.timezone ?? DEFAULT_TZ;
    const format = args.format ?? 'iso';
    const now = new Date();

    try {
      let content: string;
      if (format === 'epoch_ms') {
        content = String(now.getTime());
      } else if (format === 'human') {
        content = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now);
      } else {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(now);
        const map: Record<string, string> = {};
        for (const p of parts) map[p.type] = p.value;
        const offset = tzOffset(now, tz);
        content = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${offset} (${tz})`;
      }
      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      return {
        status: 'error',
        content: `time_now error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};

function tzOffset(date: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  const diffMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = diffMin >= 0 ? '+' : '-';
  const abs = Math.abs(diffMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
