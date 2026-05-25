import { logger } from '../logger.js';
import { slackClient } from './client.js';

export interface UploadOpts {
  channel: string;
  thread_ts?: string;
  filename: string;
  title?: string;
  initial_comment?: string;
}

export interface UploadResult {
  ok: boolean;
  file_id?: string;
  permalink?: string;
  error?: string;
}

/**
 * Upload a buffer to Slack via files.uploadV2 (web-api 7+). Wraps the
 * getUploadURLExternal / completeUploadExternal handshake.
 */
export async function uploadBufferToSlack(
  buffer: Buffer,
  opts: UploadOpts,
): Promise<UploadResult> {
  const client = slackClient();
  try {
    const params: Parameters<typeof client.files.uploadV2>[0] = {
      channel_id: opts.channel,
      filename: opts.filename,
      title: opts.title ?? opts.filename,
      file: buffer,
    };
    if (opts.thread_ts) (params as { thread_ts?: string }).thread_ts = opts.thread_ts;
    if (opts.initial_comment) (params as { initial_comment?: string }).initial_comment = opts.initial_comment;
    const r = await client.files.uploadV2(params);
    const files = (r as { files?: Array<{ files?: Array<{ id?: string; permalink?: string }> }> }).files;
    const first = files?.[0]?.files?.[0];
    return {
      ok: true,
      ...(first?.id ? { file_id: first.id } : {}),
      ...(first?.permalink ? { permalink: first.permalink } : {}),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, filename: opts.filename, channel: opts.channel },
      'slack_upload_failed',
    );
    return { ok: false, error: (err as Error).message };
  }
}
