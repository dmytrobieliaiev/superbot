import { Client as MinioClient } from 'minio';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let _client: MinioClient | null = null;
const ensuredBuckets = new Set<string>();

export function isStorageEnabled(): boolean {
  return !!env.S3_ENDPOINT && !!env.S3_ACCESS_KEY && !!env.S3_SECRET_KEY;
}

export function getS3Client(): MinioClient {
  if (_client) return _client;
  if (!isStorageEnabled()) {
    throw new Error('S3 storage not configured (S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY)');
  }
  const endpoint = env.S3_ENDPOINT!;
  const url = endpoint.includes('://') ? new URL(endpoint) : new URL(`http://${endpoint}`);
  const useSSL = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port, 10) : useSSL ? 443 : 80;

  _client = new MinioClient({
    endPoint: url.hostname,
    port,
    useSSL,
    accessKey: env.S3_ACCESS_KEY!,
    secretKey: env.S3_SECRET_KEY!,
  });
  return _client;
}

export async function ensureBucket(name: string): Promise<void> {
  if (ensuredBuckets.has(name)) return;
  const client = getS3Client();
  const exists = await client.bucketExists(name);
  if (!exists) {
    await client.makeBucket(name, 'us-east-1');
    logger.info({ bucket: name }, 'bucket_created');
  }
  ensuredBuckets.add(name);
}

export async function storeBlob(
  bucket: string,
  key: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  await ensureBucket(bucket);
  const client = getS3Client();
  await client.putObject(bucket, key, data, data.length, { 'Content-Type': contentType });
}

export async function getPresignedUrl(
  bucket: string,
  key: string,
  expirySec = 7 * 24 * 60 * 60,
): Promise<string> {
  const client = getS3Client();
  return client.presignedGetObject(bucket, key, expirySec);
}
