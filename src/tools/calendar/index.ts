import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_URL = 'https://www.googleapis.com/calendar/v3';
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min (Google tokens last 1h)

type Action = 'list_events' | 'create_event' | 'delete_event';

interface CalendarArgs {
  action: Action;
  time_min?: string; // ISO
  time_max?: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  event_id?: string;
  calendar_id?: string;
}

let cachedToken: { value: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) return cachedToken.value;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN not set');
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`google token refresh failed http_${resp.status}`);
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expires_at: Date.now() + Math.min(json.expires_in * 1000, TOKEN_TTL_MS),
  };
  return json.access_token;
}

async function calApi<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const token = await getAccessToken();
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${CAL_URL}${path}`, opts);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`google_cal http_${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

interface EventResource {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string }>;
  htmlLink?: string;
}

export const calendar: ToolSpec<CalendarArgs> = {
  name: 'calendar',
  description:
    'Google Calendar read/create/delete (single-account via GOOGLE_REFRESH_TOKEN). Actions: list_events, create_event, delete_event.',
  params_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_events', 'create_event', 'delete_event'] },
      time_min: { type: 'string', description: 'ISO datetime — list_events lower bound' },
      time_max: { type: 'string', description: 'ISO datetime — list_events upper bound' },
      title: { type: 'string' },
      start: { type: 'string', description: 'ISO datetime for create_event' },
      end: { type: 'string', description: 'ISO datetime for create_event' },
      attendees: { type: 'array', items: { type: 'string', format: 'email' } },
      event_id: { type: 'string', description: 'Event id for delete_event' },
      calendar_id: { type: 'string', default: 'primary' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  destructive: false, // create/delete arguably are, but we surface via tool ACL
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const calId = args.calendar_id ?? env.GOOGLE_CALENDAR_ID ?? 'primary';
      let content = '';
      if (args.action === 'list_events') {
        const qs = new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '20',
          timeMin: args.time_min ?? new Date().toISOString(),
        });
        if (args.time_max) qs.set('timeMax', args.time_max);
        const data = await calApi<{ items?: EventResource[] }>(
          'GET',
          `/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`,
        );
        const items = data?.items ?? [];
        content =
          items
            .map((e) => {
              const s = e.start?.dateTime ?? e.start?.date ?? '?';
              return `• ${s}  ${e.summary ?? '(untitled)'}  [${e.id ?? '?'}]`;
            })
            .join('\n') || '(no events)';
      } else if (args.action === 'create_event') {
        if (!args.title || !args.start || !args.end) throw new Error('title + start + end required');
        const body: Record<string, unknown> = {
          summary: args.title,
          start: { dateTime: args.start },
          end: { dateTime: args.end },
        };
        if (args.attendees && args.attendees.length > 0) {
          body.attendees = args.attendees.map((email) => ({ email }));
        }
        const data = await calApi<EventResource>(
          'POST',
          `/calendars/${encodeURIComponent(calId)}/events`,
          body,
        );
        content = `created: ${data?.htmlLink ?? data?.id ?? '?'}`;
      } else if (args.action === 'delete_event') {
        if (!args.event_id) throw new Error('event_id required');
        await calApi('DELETE', `/calendars/${encodeURIComponent(calId)}/events/${args.event_id}`);
        content = `deleted ${args.event_id}`;
      } else {
        throw new Error(`unknown action: ${args.action as string}`);
      }
      return {
        status: 'ok',
        content,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, action: args.action }, 'calendar_failed');
      return {
        status: 'error',
        content: `calendar error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
