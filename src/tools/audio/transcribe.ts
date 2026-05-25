import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { downloadSlackFile, isSupportedAudio } from '../../slack/download.js';
import { slackClient } from '../../slack/client.js';
import type { ToolResult, ToolSpec } from '../types.js';

const TIMEOUT_MS = 120_000;

interface TranscribeArgs {
  /** Slack file id (F…) to transcribe. */
  file_id: string;
  /** Language hint (ISO-639-1) — improves accuracy. e.g. 'en', 'uk', 'ru'. */
  language?: string;
  /** Optional prompt to bias decoding (vocabulary, names). */
  prompt?: string;
  /** Output format: 'text' (default), 'verbose_json' (with timestamps). */
  format?: 'text' | 'verbose_json';
}

function audioBase(): string {
  const base = env.AUDIO_BASE_URL ?? env.LLM_BASE_URL;
  if (!base) throw new Error('AUDIO_BASE_URL (or LLM_BASE_URL) not set');
  return base.replace(/\/$/, '');
}

function audioKey(): string {
  const key = env.AUDIO_API_KEY ?? env.LLM_API_KEY;
  if (!key) throw new Error('AUDIO_API_KEY (or LLM_API_KEY) not set');
  return key;
}

export async function transcribeBuffer(
  buf: Buffer,
  filename: string,
  mimetype: string,
  opts: { language?: string; prompt?: string; format?: TranscribeArgs['format'] } = {},
): Promise<{ text: string; raw?: unknown }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: mimetype }), filename);
  form.append('model', env.AUDIO_MODEL);
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt);
  if (opts.format) form.append('response_format', opts.format);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${audioBase()}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${audioKey()}` },
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`http_${resp.status}: ${text.slice(0, 200)}`);
    }
    if (opts.format === 'verbose_json') {
      const raw = (await resp.json()) as { text?: string };
      return { text: raw.text ?? '', raw };
    }
    const text = await resp.text();
    // OpenAI returns JSON by default; try parse, fall back to plain text
    try {
      const parsed = JSON.parse(text) as { text?: string };
      if (typeof parsed.text === 'string') return { text: parsed.text };
    } catch {
      /* plain text */
    }
    return { text };
  } finally {
    clearTimeout(t);
  }
}

export const audio_transcribe: ToolSpec<TranscribeArgs> = {
  name: 'audio_transcribe',
  description:
    'Transcribe a Slack-attached audio/voice file to text. Pass the file_id (F…). Supports m4a, mp3, wav, webm, ogg, flac.',
  params_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'Slack file id (F…)' },
      language: { type: 'string', description: 'ISO-639-1 code (e.g. en, uk, ru) — improves accuracy' },
      prompt: { type: 'string', description: 'Vocabulary/context hint to bias decoding' },
      format: { type: 'string', enum: ['text', 'verbose_json'], default: 'text' },
    },
    required: ['file_id'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.006, // ~$0.006/min Whisper-1
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const info = await slackClient().files.info({ file: args.file_id });
      const f = info.file;
      if (!f?.url_private || !f.mimetype || !f.name) {
        return err('file metadata incomplete', 'bad_file', started);
      }
      if (!isSupportedAudio(f.mimetype)) {
        return err(`unsupported audio mimetype: ${f.mimetype}`, 'bad_mime', started);
      }
      const buf = await downloadSlackFile(f.url_private);
      const opts: { language?: string; prompt?: string; format?: TranscribeArgs['format'] } = {};
      if (args.language) opts.language = args.language;
      if (args.prompt) opts.prompt = args.prompt;
      if (args.format) opts.format = args.format;
      const { text } = await transcribeBuffer(buf, f.name, f.mimetype, opts);
      return {
        status: 'ok',
        content: text || '(empty transcription)',
        meta: { latency_ms: Date.now() - started, cost_usd: 0.006, cache_hit: false },
      };
    } catch (e) {
      logger.warn({ err: (e as Error).message, file_id: args.file_id }, 'audio_transcribe_failed');
      return err(`audio_transcribe error: ${(e as Error).message}`, (e as Error).message, started);
    }
  },
};

function err(content: string, code: string, started: number): ToolResult {
  return {
    status: 'error',
    content,
    error: code,
    meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
  };
}
