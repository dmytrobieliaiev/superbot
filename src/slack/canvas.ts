import { logger } from '../logger.js';
import { slackClient } from './client.js';

export interface CanvasResult {
  ok: boolean;
  canvas_id?: string;
  error?: string;
}

interface CanvasCreateResp {
  ok: boolean;
  canvas_id?: string;
  error?: string;
}

interface CanvasAccessResp {
  ok: boolean;
  error?: string;
}

/**
 * Create a standalone canvas with markdown content and share it to a channel.
 * Returns canvas_id on success. Requires the `canvases:write` bot scope.
 */
export async function createSharedCanvas(
  title: string,
  markdown: string,
  channel_id: string,
): Promise<CanvasResult> {
  const client = slackClient();
  let canvas_id: string | undefined;
  try {
    const create = (await client.apiCall('canvases.create', {
      title,
      document_content: { type: 'markdown', markdown },
    })) as CanvasCreateResp;
    if (!create.ok || !create.canvas_id) {
      return { ok: false, error: create.error ?? 'create_failed' };
    }
    canvas_id = create.canvas_id;
  } catch (err) {
    logger.warn({ err: (err as Error).message, title }, 'canvas_create_failed');
    return { ok: false, error: (err as Error).message };
  }

  // Share canvas read access to the channel so members can open it
  try {
    const access = (await client.apiCall('canvases.access.set', {
      canvas_id,
      access_level: 'read',
      channel_ids: [channel_id],
    })) as CanvasAccessResp;
    if (!access.ok) {
      logger.warn(
        { error: access.error, canvas_id, channel_id },
        'canvas_share_failed',
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, canvas_id, channel_id },
      'canvas_share_threw',
    );
  }

  return { ok: true, canvas_id };
}

export function canvasDeepLink(canvas_id: string): string {
  // Slack deep-link to canvas. Works in Slack client; web fallback resolves
  // via app.slack.com on click.
  return `slack://canvas?canvas_id=${encodeURIComponent(canvas_id)}`;
}
