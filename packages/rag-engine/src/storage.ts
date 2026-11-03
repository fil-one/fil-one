import crypto from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { RAG_COMPANION_BUCKET_PREFIX, type RagEngineTarget } from '@filone/shared';

/** Where the Lance dataset lives inside the companion bucket. */
export const DATASET_ROOT = 'lance';
export const TABLE_NAME = 'chunks';
/** Small JSON object written next to the dataset after every sync. */
export const STATE_KEY = `${DATASET_ROOT}/engine-state.json`;

/**
 * The companion bucket for `(orgId, region, bucketName)`: the reserved prefix
 * plus the first 40 hex chars of sha256(`orgId#region#bucketName`), 51 chars
 * in all. Same derivation as the Lance spike (PR #523).
 */
export function companionBucketName(orgId: string, region: string, bucketName: string): string {
  const hash = crypto
    .createHash('sha256')
    .update([orgId, region, bucketName].join('#'))
    .digest('hex');
  return `${RAG_COMPANION_BUCKET_PREFIX}${hash.slice(0, 40)}`;
}

/** Resolved connection details for the tenant's Forge S3 gateway. */
export interface StorageContext {
  endpointUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function storageFor(target: RagEngineTarget, endpointOverride?: string): StorageContext {
  return {
    endpointUrl: endpointOverride ?? target.s3.endpointUrl,
    region: target.s3.region,
    accessKeyId: target.s3.accessKeyId,
    secretAccessKey: target.s3.secretAccessKey,
  };
}

export function createS3Client(storage: StorageContext): S3Client {
  return new S3Client({
    endpoint: storage.endpointUrl,
    region: storage.region,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
    // Forge serves path-style only.
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Lance `storageOptions` for the tenant's Forge storage. `aws_session_token`
 * is set to an empty string so a token in the process environment is never
 * attached to Forge requests (Forge keys are static).
 */
export function lanceStorageOptions(storage: StorageContext): Record<string, string> {
  const options: Record<string, string> = {
    aws_endpoint: storage.endpointUrl,
    aws_region: storage.region,
    aws_access_key_id: storage.accessKeyId,
    aws_secret_access_key: storage.secretAccessKey,
    aws_session_token: '',
    aws_virtual_hosted_style_request: 'false',
  };
  if (storage.endpointUrl.startsWith('http://')) options.allow_http = 'true';
  return options;
}

export function datasetUri(companionBucket: string): string {
  return `s3://${companionBucket}/${DATASET_ROOT}`;
}

function errorName(error: unknown): string | undefined {
  if (error instanceof S3ServiceException) return error.name;
  if (error instanceof Error) return error.name;
  return undefined;
}

export function isNoSuchBucket(error: unknown): boolean {
  if (errorName(error) === 'NoSuchBucket') return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('nosuchbucket') || message.includes('no such bucket');
}

/** Create the companion bucket if it does not exist yet. */
export async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = errorName(error);
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
    throw error;
  }
}

/** Best effort: Forge may refuse, and an empty bucket left behind is harmless. */
export async function tryDeleteBucket(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

export interface SourceObject {
  key: string;
  etag: string;
  size: number;
}

/** Every object in the bucket with an ETag, in key order. */
export async function listSourceObjects(s3: S3Client, bucket: string): Promise<SourceObject[]> {
  const out: SourceObject[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (!item.Key || !item.ETag) continue;
      out.push({ key: item.Key, etag: item.ETag, size: item.Size ?? 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function getObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`Object ${key} has no body`);
  return {
    bytes: await response.Body.transformToByteArray(),
    contentType: response.ContentType,
  };
}

export async function readJsonObject(s3: S3Client, bucket: string, key: string): Promise<unknown> {
  try {
    const { bytes } = await getObject(s3, bucket, key);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    const name = errorName(error);
    if (name === 'NoSuchKey' || name === 'NotFound' || isNoSuchBucket(error)) return undefined;
    throw error;
  }
}

export async function writeJsonObject(
  s3: S3Client,
  bucket: string,
  key: string,
  value: unknown,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
}

export async function deleteObject(s3: S3Client, bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isNoSuchBucket(error)) return;
    throw error;
  }
}
