import { describe, expect, it } from 'vitest';
import { checkAcl } from '../../src/acl/gate.js';
import type { Acl } from '../../src/config/acl.js';
import type { InboundEvent } from '../../src/slack/types.js';

const baseAcl: Acl = {
  channels: { allow: ['*'], deny: [] },
  users: { deny: [] },
  event_kinds: { enabled: ['mention', 'dm', 'shortcut', 'command', 'interactive'] },
};

function evt(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    event_id: 'evt1',
    ts: '1',
    channel_id: 'C001',
    channel_type: 'channel',
    user_id: 'U001',
    text: 'hi',
    files: [],
    mentions: [],
    kind: 'mention',
    ...over,
  };
}

describe('checkAcl', () => {
  it('allows by default with wildcard allow', () => {
    expect(checkAcl(baseAcl, evt()).allowed).toBe(true);
  });

  it('denies user on denylist', () => {
    const acl: Acl = { ...baseAcl, users: { deny: ['U001'] } };
    expect(checkAcl(acl, evt()).allowed).toBe(false);
    expect(checkAcl(acl, evt()).reason).toBe('user_denied');
  });

  it('denies channel on denylist', () => {
    const acl: Acl = {
      ...baseAcl,
      channels: { allow: ['*'], deny: ['C001'] },
    };
    expect(checkAcl(acl, evt()).reason).toBe('channel_denied');
  });

  it('denies channel not on allowlist when not wildcard', () => {
    const acl: Acl = {
      ...baseAcl,
      channels: { allow: ['C999'], deny: [] },
    };
    expect(checkAcl(acl, evt()).reason).toBe('channel_not_in_allowlist');
  });

  it('allows channel explicitly on allowlist', () => {
    const acl: Acl = {
      ...baseAcl,
      channels: { allow: ['C001'], deny: [] },
    };
    expect(checkAcl(acl, evt()).allowed).toBe(true);
  });

  it('rejects disabled event kind', () => {
    const acl: Acl = {
      ...baseAcl,
      event_kinds: { enabled: ['dm'] },
    };
    expect(checkAcl(acl, evt({ kind: 'mention' })).reason).toBe('event_kind_disabled');
  });
});
