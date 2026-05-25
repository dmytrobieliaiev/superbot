import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub env BEFORE importing the module under test.
vi.mock('../../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LLM_BASE_URL: 'https://api.example.test/v1',
    LLM_API_KEY: 'sk-test',
    AUDIO_BASE_URL: undefined,
    AUDIO_API_KEY: undefined,
    AUDIO_MODEL: 'whisper-1',
    SLACK_BOT_TOKEN: 'xoxb-test',
  },
}));

const filesInfo = vi.fn();
vi.mock('../../../src/slack/client.js', () => ({
  slackClient: () => ({ files: { info: filesInfo } }),
}));

import { audio_transcribe, transcribeBuffer } from '../../../src/tools/audio/transcribe.js';

const ctx = {
  turn_id: 't',
  user_id: 'U',
  channel_id: 'C',
  channel_type: 'channel',
};

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  filesInfo.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('transcribeBuffer', () => {
  it('POSTs multipart to /audio/transcriptions and returns text', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world' }), { status: 200 }),
    );
    const r = await transcribeBuffer(Buffer.from('fake'), 'a.mp3', 'audio/mp3');
    expect(r.text).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(init.method).toBe('POST');
  });

  it('falls back to plain text when response is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('plain transcript here', { status: 200 }));
    const r = await transcribeBuffer(Buffer.from('x'), 'a.wav', 'audio/wav');
    expect(r.text).toBe('plain transcript here');
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    await expect(transcribeBuffer(Buffer.from('x'), 'a.mp3', 'audio/mp3')).rejects.toThrow(
      /http_429/,
    );
  });
});

describe('audio_transcribe tool', () => {
  it('rejects unsupported mimetypes', async () => {
    filesInfo.mockResolvedValue({
      file: {
        url_private: 'https://files.slack.com/f',
        mimetype: 'application/pdf',
        name: 'a.pdf',
      },
    });
    const r = await audio_transcribe.execute({ file_id: 'F1' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('bad_mime');
  });

  it('errors when slack file info is incomplete', async () => {
    filesInfo.mockResolvedValue({ file: { mimetype: 'audio/mp3' } });
    const r = await audio_transcribe.execute({ file_id: 'F1' } as never, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toBe('bad_file');
  });
});
