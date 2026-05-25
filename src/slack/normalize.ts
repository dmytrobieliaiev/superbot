import type { ChannelType, EventKind, InboundEvent, SlackFile } from './types.js';

interface SlackMessageEvent {
  type?: string;
  ts?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  thread_ts?: string;
  files?: SlackFile[];
  bot_id?: string;
  subtype?: string;
}

interface SlackEventBody {
  event_id?: string;
  event_ts?: string;
  event?: SlackMessageEvent;
}

interface SlackCommandPayload {
  trigger_id?: string;
  user_id?: string;
  channel_id?: string;
  command?: string;
  text?: string;
}

function extractMentions(text: string): string[] {
  const matches = text.match(/<@([A-Z0-9]+)>/g) ?? [];
  return matches.map((m) => m.slice(2, -1));
}

function pickChannelType(raw?: string): ChannelType {
  switch (raw) {
    case 'im':
      return 'im';
    case 'mpim':
      return 'mpim';
    case 'group':
      return 'group';
    case 'channel':
      return 'channel';
    default:
      return 'unknown';
  }
}

function pickEventKind(type: string, channelType: ChannelType): EventKind {
  if (type === 'app_mention') return 'mention';
  if (type === 'reaction_added') return 'reaction';
  if (type === 'message' && channelType === 'im') return 'dm';
  return 'mention';
}

export function normalizeMessageEvent(body: SlackEventBody): InboundEvent | null {
  const event = body.event;
  if (!event) return null;
  if (event.bot_id) return null;
  if (event.subtype === 'bot_message') return null;
  if (event.subtype === 'message_changed' || event.subtype === 'message_deleted') return null;
  if (!event.user || !event.channel || !event.ts) return null;

  const text = event.text ?? '';
  const channelType = pickChannelType(event.channel_type);
  const evt: InboundEvent = {
    event_id: body.event_id ?? `${event.channel}-${event.ts}`,
    ts: event.ts,
    channel_id: event.channel,
    channel_type: channelType,
    user_id: event.user,
    text,
    files: event.files ?? [],
    mentions: extractMentions(text),
    kind: pickEventKind(event.type ?? '', channelType),
  };
  if (event.thread_ts) evt.thread_ts = event.thread_ts;
  return evt;
}

export function normalizeCommandPayload(payload: SlackCommandPayload): InboundEvent | null {
  if (!payload.user_id || !payload.channel_id || !payload.command) return null;
  const ts = Date.now().toString();
  return {
    event_id: `cmd-${payload.trigger_id ?? ts}`,
    ts,
    channel_id: payload.channel_id,
    channel_type: 'unknown',
    user_id: payload.user_id,
    text: `${payload.command} ${payload.text ?? ''}`.trim(),
    files: [],
    mentions: [],
    kind: 'command',
  };
}
