// Provider-agnostic S3 presign/list/delete helpers. Each function accepts a
// PresignerContext supplied by the active ServiceOrchestrator; the orchestrator
// alone knows how to look up credentials and which endpoint/region apply.

import {
  CreateBucketCommand,
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
import { BucketAlreadyExistsError } from './errors.js';
import type { PresignerContext } from './service-orchestrator.js';

// AWS SDK JS hoists every `x-amz-*` request header into the presigned URL's
// query string by default. For S3-compatible backends that strictly validate
// the canonical query string (Fortilyx/FTH, Aurora's S3 gateway), this
// produces URLs that look unlike anything boto3 generates and get rejected —
// Fortilyx returns `{"error":"invalid_presigned_request"}`. `X-Amz-Content-Sha256`
// is the worst offender: boto3 never adds it to the query, but the SDK JS
// presigner force-sets the header to `UNSIGNED-PAYLOAD` and then hoists it.
// Keep it as an unhoisted, unsignable header so it disappears from the URL.
const PRESIGN_OPTIONS = {
  unhoistableHeaders: new Set(['x-amz-content-sha256']),
  unsignableHeaders: new Set(['x-amz-content-sha256']),
};

function createS3Client(ctx: PresignerContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
    // The flexible-checksums middleware (default WHEN_SUPPORTED in SDK JS
    // 3.717+) hoists `x-amz-checksum-crc32` and `x-amz-sdk-checksum-algorithm`
    // onto presigned URLs. The hoisted CRC32 is computed over an empty body
    // (the SDK can't see the body at presign time), so it never matches the
    // real upload payload and S3-compatible backends reject or hang the PUT.
    // boto3 (which produces working URLs against the same backends) doesn't
    // include these params, so disable the middleware here.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

// ── Direct S3 operations (used by handlers that can't presign) ─────

export interface CreateBucketOptions {
  bucketName: string;
}

export async function createBucket(
  ctx: PresignerContext,
  options: CreateBucketOptions,
): Promise<void> {
  const s3 = createS3Client(ctx);
  try {
    await s3.send(new CreateBucketCommand({ Bucket: options.bucketName }));
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
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
    { expiresIn, ...PRESIGN_OPTIONS },
  );
}
