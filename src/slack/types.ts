export type EventKind =
  | 'mention'
  | 'dm'
  | 'shortcut'
  | 'command'
  | 'interactive'
  | 'reaction';

export type ChannelType = 'channel' | 'group' | 'im' | 'mpim' | 'unknown';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  size: number;
}

export interface InboundEvent {
  event_id: string;
  ts: string;
  channel_id: string;
  channel_type: ChannelType;
  user_id: string;
  thread_ts?: string;
  text: string;
  files: SlackFile[];
  mentions: string[];
  kind: EventKind;
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
}

export interface UserInfo {
  name?: string;
  tz?: string;
  is_bot?: boolean;
}

export interface ChannelInfo {
  name?: string;
  topic?: string;
  is_private?: boolean;
}

export interface EnrichedEvent extends InboundEvent {
  user_info?: UserInfo;
  channel_info?: ChannelInfo;
  thread_backlog?: ThreadMessage[];
  user_profile?: Record<string, unknown>;
}
