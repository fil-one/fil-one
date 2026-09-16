// Direct S3 operations (bucket lifecycle, versioning, object-lock, listing).

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { RetentionDurationType, RetentionMode, S3Object } from '@filone/shared';
import { BucketAlreadyExistsError, BucketNotEmptyError } from './errors.ts';

/**
 * Per-call options a caller passes to bound one S3 operation. The caller owns
 * the budget: a deadline signal makes a hung S3 endpoint fail the call instead
 * of holding the Lambda open until its own timeout.
 */
export interface S3RequestOptions {
  /** Aborts the S3 request. */
  signal?: AbortSignal;
}

// The SDK spells the signal `abortSignal`. Omit the options object entirely
// when the caller passed no signal; the SDK treats a missing second argument
// and `undefined` the same way.
const toSendOptions = (requestOptions?: S3RequestOptions) =>
  requestOptions?.signal ? { abortSignal: requestOptions.signal } : undefined;

export interface CreateBucketOptions {
  bucketName: string;
  objectLockEnabled?: boolean;
}

export async function createBucket(
  s3: S3Client,
  options: CreateBucketOptions,
  requestOptions?: S3RequestOptions,
): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: options.bucketName,
        ...(options.objectLockEnabled && { ObjectLockEnabledForBucket: true }),
      }),
      toSendOptions(requestOptions),
    );
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      throw new BucketAlreadyExistsError(options.bucketName, { cause: err as Error });
    }
    throw err;
  }
}

export interface ListBucketsResult {
  buckets: Array<{ name: string; createdAt: string }>;
}

export async function listBuckets(
  s3: S3Client,
  requestOptions?: S3RequestOptions,
): Promise<ListBucketsResult> {
  const result = await s3.send(new ListBucketsCommand({}), toSendOptions(requestOptions));
  return {
    buckets: (result.Buckets ?? []).map((b) => ({
      name: b.Name!,
      createdAt: b.CreationDate?.toISOString() ?? new Date().toISOString(),
    })),
  };
}

// Map between our domain RetentionMode and the S3 wire enum.
const toS3RetentionMode = (m: RetentionMode) => (m === 'compliance' ? 'COMPLIANCE' : 'GOVERNANCE');
const fromS3RetentionMode = (m: string): RetentionMode => {
  if (m === 'COMPLIANCE') return 'compliance';
  if (m === 'GOVERNANCE') return 'governance';
  throw new Error(`Unknown S3 retention mode: ${m}`);
};

export async function setBucketVersioning(
  s3: S3Client,
  bucketName: string,
  enabled = true,
  requestOptions?: S3RequestOptions,
): Promise<void> {
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' },
    }),
    toSendOptions(requestOptions),
  );
}

export interface PutObjectLockConfigurationOptions {
  bucketName: string;
  mode: RetentionMode;
  duration: number;
  durationType: RetentionDurationType;
}

export async function putObjectLockConfiguration(
  s3: S3Client,
  options: PutObjectLockConfigurationOptions,
  requestOptions?: S3RequestOptions,
): Promise<void> {
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: options.bucketName,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: {
            Mode: toS3RetentionMode(options.mode),
            ...(options.durationType === 'y'
              ? { Years: options.duration }
              : { Days: options.duration }),
          },
        },
      },
    }),
    toSendOptions(requestOptions),
  );
}

/**
 * S3's three-state versioning model. `Suspended` is distinct from `Never`: a
 * bucket that had versioning enabled and later suspended it still tracks a
 * `null` version per key, and a plain (no version id) delete on such a key
 * leaves that null version in place behind a new null-version delete marker
 * rather than removing it. `Never` never went through `Enabled`, so its
 * objects have no real version identity and only support a plain delete.
 */
export type BucketVersioningStatus = 'Enabled' | 'Suspended' | 'Never';

export async function getBucketVersioningStatus(
  s3: S3Client,
  bucketName: string,
  requestOptions?: S3RequestOptions,
): Promise<BucketVersioningStatus> {
  const result = await s3.send(
    new GetBucketVersioningCommand({ Bucket: bucketName }),
    toSendOptions(requestOptions),
  );
  if (result.Status === 'Enabled' || result.Status === 'Suspended') return result.Status;
  return 'Never';
}

export async function getBucketVersioning(
  s3: S3Client,
  bucketName: string,
  requestOptions?: S3RequestOptions,
): Promise<boolean> {
  return (await getBucketVersioningStatus(s3, bucketName, requestOptions)) === 'Enabled';
}

export interface BucketObjectLockState {
  objectLockEnabled: boolean;
  defaultRetention?: RetentionMode;
  retentionDuration?: number;
  retentionDurationType?: RetentionDurationType;
}

export async function getBucketObjectLock(
  s3: S3Client,
  bucketName: string,
  requestOptions?: S3RequestOptions,
): Promise<BucketObjectLockState | null> {
  try {
    const result = await s3.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucketName }),
      toSendOptions(requestOptions),
    );
    const cfg = result.ObjectLockConfiguration;
    const defaultRetention = cfg?.Rule?.DefaultRetention;
    return {
      objectLockEnabled: cfg?.ObjectLockEnabled === 'Enabled',
      ...(defaultRetention?.Mode && {
        defaultRetention: fromS3RetentionMode(defaultRetention.Mode),
      }),
      ...(defaultRetention?.Years != null
        ? { retentionDuration: defaultRetention.Years, retentionDurationType: 'y' as const }
        : defaultRetention?.Days != null
          ? { retentionDuration: defaultRetention.Days, retentionDurationType: 'd' as const }
          : {}),
    };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'ObjectLockConfigurationNotFoundError') {
      return null;
    }
    throw err;
  }
}

export interface ListObjectsOptions extends S3RequestOptions {
  s3: S3Client;
  bucket: string;
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListObjectsResult {
  objects: S3Object[];
  nextToken?: string;
  isTruncated: boolean;
}

export async function listObjects(options: ListObjectsOptions): Promise<ListObjectsResult> {
  const { s3, bucket, prefix, delimiter, maxKeys, continuationToken, signal } = options;

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(delimiter && { Delimiter: delimiter }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(continuationToken && { ContinuationToken: continuationToken }),
    }),
    toSendOptions({ signal }),
  );

  const objects: S3Object[] = (result.Contents ?? []).map((item) => ({
    key: item.Key!,
    sizeBytes: item.Size ?? 0,
    lastModified: item.LastModified?.toISOString() ?? new Date().toISOString(),
    ...(item.ETag && { etag: item.ETag }),
  }));

  return {
    objects,
    nextToken: result.NextContinuationToken,
    isTruncated: result.IsTruncated ?? false,
  };
}

export interface GetObjectBytesResult {
  bytes: Uint8Array;
  /** The object's stored Content-Type, when S3 reports one. */
  contentType?: string;
}

/**
 * Fetch a single object's bytes and stored content type. Used by the RAG
 * indexer to read object contents for extraction. The content type comes from
 * GetObject's response (no extra HeadObject call); callers fall back to a
 * key-extension guess when S3 reports nothing useful.
 */
export async function getObjectBytes(
  s3: S3Client,
  bucket: string,
  key: string,
  requestOptions?: S3RequestOptions,
): Promise<GetObjectBytesResult> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    toSendOptions(requestOptions),
  );
  if (!result.Body) {
    throw new Error(`Object "${key}" in bucket "${bucket}" returned an empty body`);
  }
  const bytes = await result.Body.transformToByteArray();
  return {
    bytes,
    ...(result.ContentType && { contentType: result.ContentType }),
  };
}

export async function deleteBucket(
  s3: S3Client,
  bucketName: string,
  requestOptions?: S3RequestOptions,
): Promise<void> {
  try {
    await s3.send(
      new DeleteBucketCommand({
        Bucket: bucketName,
      }),
      toSendOptions(requestOptions),
    );
  } catch (err) {
    const name = (err as { name?: string }).name;

    // Already deleted — treat as success
    if (name === 'NoSuchBucket') {
      return;
    }

    if (name === 'BucketNotEmpty') {
      throw new BucketNotEmptyError(bucketName, { cause: err as Error });
    }

    throw err;
  }
}
