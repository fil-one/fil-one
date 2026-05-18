import {
  S3Client,
  PutObjectCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { S3Object } from '@filone/shared';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';

const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });
export const _resetSsmCacheForTesting = () => ssmCache.clear();

export interface AuroraS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function createS3Client(endpointUrl: string, credentials: AuroraS3Credentials): S3Client {
  return new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

export async function getAuroraS3Credentials(
  stage: string,
  tenantId: string,
): Promise<AuroraS3Credentials> {
  const cacheKey = `${stage}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as AuroraS3Credentials;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/aurora-s3/access-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    value = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`Aurora S3 credentials not found in SSM for tenant ${tenantId}`);
    }
    throw err;
  }

  if (!value) {
    throw new Error(`Aurora S3 credentials not found in SSM for tenant ${tenantId}`);
  }

  ssmCache.set(cacheKey, value);
  return JSON.parse(value) as AuroraS3Credentials;
}

// ── Direct S3 operations (used by handlers that can't presign) ─────

export interface ListBucketsResult {
  buckets: Array<{ name: string; createdAt: string }>;
}

export async function listBuckets(
  endpointUrl: string,
  credentials: AuroraS3Credentials,
): Promise<ListBucketsResult> {
  const s3 = createS3Client(endpointUrl, credentials);
  const result = await s3.send(new ListBucketsCommand({}));
  return {
    buckets: (result.Buckets ?? []).map((b) => ({
      name: b.Name!,
      createdAt: b.CreationDate?.toISOString() ?? new Date().toISOString(),
    })),
  };
}

export async function deleteBucket(
  endpointUrl: string,
  credentials: AuroraS3Credentials,
  bucket: string,
): Promise<void> {
  const s3 = createS3Client(endpointUrl, credentials);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export interface ListObjectsOptions {
  endpointUrl: string;
  credentials: AuroraS3Credentials;
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
  const { endpointUrl, credentials, bucket, prefix, delimiter, maxKeys, continuationToken } =
    options;

  const s3 = createS3Client(endpointUrl, credentials);

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
  endpointUrl: string;
  credentials: AuroraS3Credentials;
  bucket: string;
  expiresIn: number;
}

export interface PresignPutObjectOptions extends PresignBaseOptions {
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export async function getPresignedPutObjectUrl(options: PresignPutObjectOptions): Promise<string> {
  const { endpointUrl, credentials, bucket, key, expiresIn, contentType, metadata } = options;
  const s3 = createS3Client(endpointUrl, credentials);

  console.log('[aurora-s3] Creating presigned PutObject URL', {
    endpoint: endpointUrl,
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
  const { endpointUrl, credentials, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(endpointUrl, credentials);

  console.log('[aurora-s3] Creating presigned GetObject URL', {
    endpoint: endpointUrl,
    bucket,
    key,
    expiresIn,
  });

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
  const {
    endpointUrl,
    credentials,
    bucket,
    expiresIn,
    prefix,
    delimiter,
    maxKeys,
    continuationToken,
  } = options;
  const s3 = createS3Client(endpointUrl, credentials);

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
  const {
    endpointUrl,
    credentials,
    bucket,
    expiresIn,
    prefix,
    delimiter,
    maxKeys,
    keyMarker,
    versionIdMarker,
  } = options;
  const s3 = createS3Client(endpointUrl, credentials);

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
  const { endpointUrl, credentials, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(endpointUrl, credentials);

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
  const { endpointUrl, credentials, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(endpointUrl, credentials);

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
  const { endpointUrl, credentials, bucket, key, expiresIn, versionId } = options;
  const s3 = createS3Client(endpointUrl, credentials);

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
