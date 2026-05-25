import { describe, expect, it } from 'vitest';
import {
  normalizeCommandPayload,
  normalizeMessageEvent,
} from '../../src/slack/normalize.js';

describe('normalizeMessageEvent', () => {
  it('returns null when event missing', () => {
    expect(normalizeMessageEvent({})).toBeNull();
  });

  it('drops bot messages', () => {
    expect(
      normalizeMessageEvent({
        event: { type: 'message', bot_id: 'B1', user: 'U1', channel: 'C1', ts: '1' },
      }),
    ).toBeNull();
  });

  it('drops message_changed/deleted subtypes', () => {
    expect(
      normalizeMessageEvent({
        event: {
          type: 'message',
          subtype: 'message_changed',
          user: 'U1',
          channel: 'C1',
          ts: '1',
        },
      }),
    ).toBeNull();
  });

  it('extracts mention as kind=mention', () => {
    const r = normalizeMessageEvent({
      event_id: 'E1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        ts: '100',
        text: 'hello <@UBOT> world',
        channel_type: 'channel',
      },
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('mention');
    expect(r!.mentions).toEqual(['UBOT']);
    expect(r!.channel_type).toBe('channel');
  });

  it('classifies DM as kind=dm', () => {
    const r = normalizeMessageEvent({
      event: {
        type: 'message',
        user: 'U1',
        channel: 'D1',
        ts: '100',
        text: 'hi',
        channel_type: 'im',
      },
    });
    expect(r!.kind).toBe('dm');
  });

  it('preserves thread_ts when present', () => {
    const r = normalizeMessageEvent({
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        ts: '100',
        thread_ts: '50',
        text: '',
      },
    });
    expect(r!.thread_ts).toBe('50');
  });

  it('omits thread_ts when not in event', () => {
    const r = normalizeMessageEvent({
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100', text: '' },
    });
    expect(r!.thread_ts).toBeUndefined();
  });
});

describe('normalizeCommandPayload', () => {
  it('returns null if required field missing', () => {
    expect(normalizeCommandPayload({})).toBeNull();
  });

  it('builds event with kind=command', () => {
    const r = normalizeCommandPayload({
      trigger_id: 'tr1',
      user_id: 'U1',
      channel_id: 'C1',
      command: '/ask',
      text: 'what is the time',
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('command');
    expect(r!.text).toBe('/ask what is the time');
  });
});
