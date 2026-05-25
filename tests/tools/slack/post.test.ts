import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ACL — return true unless we override per test
vi.mock('../../../src/config/tool-acl.js', () => ({
  checkToolAcl: vi.fn(() => true),
}));

// Mock slack client
const postMessage = vi.fn();
const conversationsOpen = vi.fn();
vi.mock('../../../src/slack/client.js', () => ({
  slackClient: () => ({
    chat: { postMessage },
    conversations: { open: conversationsOpen },
  }),
}));

import { checkToolAcl } from '../../../src/config/tool-acl.js';
import { slack_post } from '../../../src/tools/slack/post.js';

const ctx = {
  turn_id: 't1',
  user_id: 'U1',
  channel_id: 'C1',
  channel_type: 'channel',
};

describe('slack_post arg validation', () => {
  beforeEach(() => {
    postMessage.mockReset();
    conversationsOpen.mockReset();
    vi.mocked(checkToolAcl).mockReset();
    vi.mocked(checkToolAcl).mockReturnValue(true);
  });

  it('errors when neither channel nor user provided', async () => {
    const r = await slack_post.execute({ text: 'hi' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('bad_args');
  });

  it('errors when both channel and user provided', async () => {
    const r = await slack_post.execute(
      { channel: 'C9', user: 'U9', text: 'hi' } as never,
      ctx,
    );
    expect(r.status).toBe('error');
    expect(r.error).toBe('bad_args');
  });

  it('blocks DM when slack_dm_targets ACL denies', async () => {
    vi.mocked(checkToolAcl).mockImplementation((toolName: string) => {
      return toolName !== 'slack_dm_targets';
    });
    const r = await slack_post.execute({ user: 'U9', text: 'hi' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('acl_target_user');
    expect(conversationsOpen).not.toHaveBeenCalled();
  });

  it('blocks channel post when slack_post_targets ACL denies', async () => {
    vi.mocked(checkToolAcl).mockImplementation((toolName: string) => {
      return toolName !== 'slack_post_targets';
    });
    const r = await slack_post.execute({ channel: 'C9', text: 'hi' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('acl_target_channel');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('opens IM and posts to it when user supplied', async () => {
    conversationsOpen.mockResolvedValue({ channel: { id: 'D123' } });
    postMessage.mockResolvedValue({ ts: '1234.5' });
    const r = await slack_post.execute({ user: 'U9', text: 'ping' } as never, ctx);
    expect(r.status).toBe('ok');
    expect(conversationsOpen).toHaveBeenCalledWith({ users: 'U9' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D123', text: 'ping' }),
    );
  });

  it('drops thread_ts when posting a DM (user route)', async () => {
    conversationsOpen.mockResolvedValue({ channel: { id: 'D123' } });
    postMessage.mockResolvedValue({ ts: '1234.5' });
    await slack_post.execute(
      { user: 'U9', text: 'ping', thread_ts: 'T1' } as never,
      ctx,
    );
    const call = postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.thread_ts).toBeUndefined();
  });

  it('passes thread_ts when posting to a channel', async () => {
    postMessage.mockResolvedValue({ ts: '1234.5' });
    await slack_post.execute(
      { channel: 'C9', text: 'hi', thread_ts: 'T1' } as never,
      ctx,
    );
    const call = postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.thread_ts).toBe('T1');
    expect(call.channel).toBe('C9');
  });

  it('returns dm_open_failed when conversations.open throws', async () => {
    conversationsOpen.mockRejectedValue(new Error('boom'));
    const r = await slack_post.execute({ user: 'U9', text: 'x' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('dm_open_failed');
  });
});
