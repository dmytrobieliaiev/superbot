import { env } from '../config/env.js';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — vision providers reject larger
const TIMEOUT_MS = 30_000;

export const SUPPORTED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export const SUPPORTED_AUDIO_MIME = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
]);

export function isSupportedImage(mimetype: string): boolean {
  return SUPPORTED_IMAGE_MIME.has(mimetype.toLowerCase());
}

export function isSupportedAudio(mimetype: string): boolean {
  return SUPPORTED_AUDIO_MIME.has(mimetype.toLowerCase());
}

export async function downloadSlackFile(url: string): Promise<Buffer> {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN not set');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`download_failed http_${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      throw new Error(`file too large: ${buf.length} bytes > ${MAX_BYTES}`);
    }
    return buf;
  } finally {
    clearTimeout(t);
  }
}

export async function slackImageToDataUrl(
  url: string,
  mimetype: string,
): Promise<string> {
  const buf = await downloadSlackFile(url);
  return `data:${mimetype};base64,${buf.toString('base64')}`;
}
