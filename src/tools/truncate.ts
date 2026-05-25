import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { getPresignedUrl, isStorageEnabled, storeBlob } from '../storage/s3.js';
import type { ToolArtifact, ToolResult } from './types.js';

const DEFAULT_MAX_CHARS = 32_000; // ~8k tokens at 4 chars/token
const ARTIFACTS_BUCKET = 'tool-artifacts';

/**
 * Truncate result.content to a char budget. If MinIO is configured, the full
 * result is uploaded and a presigned URL is added to artifacts + the excerpt note.
 */
export async function truncateResult(
  result: ToolResult,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ToolResult> {
  if (result.content.length <= maxChars) return result;

  let fullUrl: string | undefined;
  if (isStorageEnabled()) {
    try {
      const dateDir = new Date().toISOString().slice(0, 10);
      const key = `${dateDir}/${randomUUID()}.txt`;
      const buf = Buffer.from(result.content, 'utf-8');
      await storeBlob(ARTIFACTS_BUCKET, key, buf, 'text/plain; charset=utf-8');
      fullUrl = await getPresignedUrl(ARTIFACTS_BUCKET, key);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'truncate_s3_upload_failed');
    }
  }

  const excerpt = result.content.slice(0, maxChars);
  const dropped = result.content.length - maxChars;
  const note = fullUrl
    ? `\n\n…[truncated ${dropped} chars; full result at ${fullUrl}]`
    : `\n\n…[truncated ${dropped} chars; storage not configured]`;

  const artifacts: ToolArtifact[] = [...(result.artifacts ?? [])];
  if (fullUrl) {
    artifacts.push({
      name: 'full_result.txt',
      mime: 'text/plain',
      url: fullUrl,
      size_bytes: Buffer.byteLength(result.content, 'utf-8'),
    });
  }

  return {
    ...result,
    content: excerpt + note,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    meta: { ...result.meta, truncated: true },
  };
}
