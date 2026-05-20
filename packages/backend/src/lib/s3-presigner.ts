// Provider-agnostic S3 presign/list/delete helpers. Each function accepts a
// PresignerContext supplied by the active ServiceOrchestrator; the orchestrator
// alone knows how to look up credentials and which endpoint/region apply.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Object } from '@filone/shared';
import type { PresignerContext } from './service-orchestrator.js';

function createS3Client(ctx: PresignerContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
  });
}

// ── Direct S3 operations (used by handlers that can't presign) ─────

export interface ListBucketsResult {
  buckets: Array<{ name: string; createdAt: string }>;
}

export async function listBuckets(ctx: PresignerContext): Promise<ListBucketsResult> {
  const s3 = createS3Client(ctx);
  const result = await s3.send(new ListBucketsCommand({}));
  return {
    buckets: (result.Buckets ?? []).map((b) => ({
      name: b.Name!,
      createdAt: b.CreationDate?.toISOString() ?? new Date().toISOString(),
    })),
  };
}

export interface ListObjectsOptions {
  ctx: PresignerContext;
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
  const { ctx, bucket, prefix, delimiter, maxKeys, continuationToken } = options;
  const s3 = createS3Client(ctx);

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

// ── Presigned URL generators ────────────────────────────────────────

interface PresignBaseOptions {
  ctx: PresignerContext;
  bucket: string;
  expiresIn: number;
}

export interface PresignPutObjectOptions extends PresignBaseOptions {
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export async function getPresignedPutObjectUrl(options: PresignPutObjectOptions): Promise<string> {
  const { ctx, bucket, key, expiresIn, contentType, metadata } = options;
  const s3 = createS3Client(ctx);

  console.log('[s3-presigner] Creating presigned PutObject URL', {
    endpoint: ctx.endpointUrl,
    bucket,
    key,
    expiresIn,
  });

  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(contentType && { ContentType: contentType }),
      ...(metadata && { Metadata: metadata }),
    }),
    { expiresIn },
  );
}

export type PresignGetObjectOptions = PresignBaseOptions & { key: string; versionId?: string };

export async function getPresignedGetObjectUrl(options: PresignGetObjectOptions): Promise<string> {
  const { ctx, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId && { VersionId: versionId }),
    }),
    { expiresIn },
  );
}

export interface PresignListObjectsOptions extends PresignBaseOptions {
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export async function getPresignedListObjectsUrl(
  options: PresignListObjectsOptions,
): Promise<string> {
  const { ctx, bucket, expiresIn, prefix, delimiter, maxKeys, continuationToken } = options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new ListObjectsV2Command({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(delimiter && { Delimiter: delimiter }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(continuationToken && { ContinuationToken: continuationToken }),
    }),
    { expiresIn },
  );
}

export interface PresignListObjectVersionsOptions extends PresignBaseOptions {
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  keyMarker?: string;
  versionIdMarker?: string;
}

export async function getPresignedListObjectVersionsUrl(
  options: PresignListObjectVersionsOptions,
): Promise<string> {
  const { ctx, bucket, expiresIn, prefix, delimiter, maxKeys, keyMarker, versionIdMarker } =
    options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(delimiter && { Delimiter: delimiter }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(keyMarker && { KeyMarker: keyMarker }),
      ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
    }),
    { expiresIn },
  );
}

export interface PresignHeadObjectOptions extends PresignBaseOptions {
  key: string;
  versionId?: string;
}

export async function getPresignedHeadObjectUrl(
  options: PresignHeadObjectOptions,
): Promise<string> {
  const { ctx, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId && { VersionId: versionId }),
    }),
    { expiresIn },
  );
}

export type PresignGetObjectRetentionOptions = PresignBaseOptions & {
  key: string;
  versionId?: string;
};

export async function getPresignedGetObjectRetentionUrl(
  options: PresignGetObjectRetentionOptions,
): Promise<string> {
  const { ctx, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new GetObjectRetentionCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId && { VersionId: versionId }),
    }),
    { expiresIn },
  );
}

export type PresignDeleteObjectOptions = PresignBaseOptions & {
  key: string;
  versionId?: string;
};

export async function getPresignedDeleteObjectUrl(
  options: PresignDeleteObjectOptions,
): Promise<string> {
  const { ctx, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(ctx);

  return getSignedUrl(
    s3,
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId && { VersionId: versionId }),
    }),
    { expiresIn },
  );
}
