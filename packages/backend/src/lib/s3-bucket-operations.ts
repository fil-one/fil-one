// Direct S3 operations (bucket lifecycle, versioning, object-lock, listing).

import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { RetentionDurationType, RetentionMode, S3Object } from '@filone/shared';
import { BucketAlreadyExistsError } from './errors.js';

export interface CreateBucketOptions {
  bucketName: string;
  objectLockEnabled?: boolean;
}

export async function createBucket(s3: S3Client, options: CreateBucketOptions): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: options.bucketName,
        ...(options.objectLockEnabled && { ObjectLockEnabledForBucket: true }),
      }),
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

export async function listBuckets(s3: S3Client): Promise<ListBucketsResult> {
  const result = await s3.send(new ListBucketsCommand({}));
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
): Promise<void> {
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' },
    }),
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
  );
}

export async function getBucketVersioning(s3: S3Client, bucketName: string): Promise<boolean> {
  const result = await s3.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
  return result.Status === 'Enabled';
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
): Promise<BucketObjectLockState | null> {
  try {
    const result = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucketName }));
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

export interface ListObjectsOptions {
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
  const { s3, bucket, prefix, delimiter, maxKeys, continuationToken } = options;

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(delimiter && { Delimiter: delimiter }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(continuationToken && { ContinuationToken: continuationToken }),
    }),
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
