// Provider-agnostic S3 presigned-URL generators. Each function accepts an
// S3ClientContext supplied by the active ServiceOrchestrator; the orchestrator
// alone knows how to look up credentials and which endpoint/region apply.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from './s3-client.js';
import type { S3ClientContext } from './s3-client.js';

// ── Presigned URL generators ────────────────────────────────────────

interface PresignBaseOptions {
  ctx: S3ClientContext;
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
