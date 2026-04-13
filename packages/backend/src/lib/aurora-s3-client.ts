import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  HeadObjectCommand,
  GetObjectRetentionCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3Object } from '@filone/shared';
import { getS3Endpoint, S3Region } from '@filone/shared';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';

const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });
export const _resetSsmCacheForTesting = () => ssmCache.clear();

// One S3Client per (stage, region, tenantId) — reused across Lambda warm
// invocations. Capped at 500 entries to match the SSM credential cache.
const s3ClientCache = new QuickLRU<string, S3Client>({ maxSize: 500 });
export const _resetS3ClientCacheForTesting = () => s3ClientCache.clear();

export function getAuroraS3Client(stage: string, region: S3Region, tenantId: string): S3Client {
  const cacheKey = `${stage}/${region}/${tenantId}`;
  const cached = s3ClientCache.get(cacheKey);
  if (cached) return cached;

  const client = new S3Client({
    endpoint: getS3Endpoint(region, stage),
    region: 'auto',
    credentials: async () => {
      const { accessKeyId, secretAccessKey } = await getAuroraS3Credentials(stage, tenantId);
      return { accessKeyId, secretAccessKey };
    },
    forcePathStyle: true,
  });
  s3ClientCache.set(cacheKey, client);
  return client;
}

export interface AuroraS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
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

export interface PresignPutObjectOptions {
  bucket: string;
  key: string;
  expiresIn: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export async function getPresignedPutObjectUrl(
  s3: S3Client,
  options: PresignPutObjectOptions,
): Promise<string> {
  const { bucket, key, expiresIn, contentType, metadata } = options;

  console.log('[aurora-s3] Creating presigned PutObject URL', {
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

export interface PresignGetObjectOptions {
  bucket: string;
  key: string;
  expiresIn: number;
}

export async function getPresignedGetObjectUrl(
  s3: S3Client,
  options: PresignGetObjectOptions,
): Promise<string> {
  const { bucket, key, expiresIn } = options;

  console.log('[aurora-s3] Creating presigned GetObject URL', {
    bucket,
    key,
    expiresIn,
  });

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
}

export async function deleteObject(s3: S3Client, bucket: string, key: string): Promise<void> {
  console.log('[aurora-s3] Deleting object', { bucket, key });

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
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

export async function deleteBucket(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export interface ListObjectsOptions {
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

export async function listObjects(
  s3: S3Client,
  options: ListObjectsOptions,
): Promise<ListObjectsResult> {
  const { bucket, prefix, delimiter, maxKeys, continuationToken } = options;

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

export interface HeadObjectResult {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  filCid?: string;
}

export async function headObject(
  s3: S3Client,
  bucketName: string,
  key: string,
): Promise<HeadObjectResult> {
  const command = new HeadObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  // Inject fil-include-meta=1 query parameter so Aurora returns
  // X-Fil-Cid and X-Fil-Offload-Status headers in the response.
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { query?: Record<string, string> };
      if (request.query) {
        request.query['fil-include-meta'] = '1';
      }
      return next(args);
    },
    { step: 'build', name: 'filIncludeMetaQuery' },
  );

  // Capture X-Fil-Cid response header that the SDK would otherwise discard.
  let filCid: string | undefined;

  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response as { headers?: Record<string, string> };
      if (response.headers) {
        filCid = response.headers['x-fil-cid'];
      }
      return result;
    },
    { step: 'deserialize', name: 'filMetaResponse', override: true },
  );

  console.log('[aurora-s3] HeadObject', { bucket: bucketName, key });

  const result = await s3.send(command);

  return {
    key,
    sizeBytes: result.ContentLength ?? 0,
    lastModified: result.LastModified?.toISOString() ?? new Date().toISOString(),
    ...(result.ETag && { etag: result.ETag }),
    ...(result.ContentType && { contentType: result.ContentType }),
    ...(result.Metadata && { metadata: result.Metadata }),
    ...(filCid && { filCid }),
  };
}

export interface ObjectRetention {
  mode: 'GOVERNANCE' | 'COMPLIANCE';
  retainUntilDate: string;
}

export async function getObjectRetention(
  s3: S3Client,
  bucketName: string,
  key: string,
): Promise<ObjectRetention | null> {
  try {
    const result = await s3.send(
      new GetObjectRetentionCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );

    const mode = result.Retention?.Mode;
    const retainUntilDate = result.Retention?.RetainUntilDate;

    if (!mode || !retainUntilDate) {
      return null;
    }

    return {
      mode: mode as 'GOVERNANCE' | 'COMPLIANCE',
      retainUntilDate: retainUntilDate.toISOString(),
    };
  } catch (err) {
    // Objects without retention return an error — this is expected.
    if ((err as { name?: string }).name === 'NoSuchObjectLockConfiguration') {
      return null;
    }
    // Also handle the case where the bucket doesn't have Object Lock enabled.
    const errName = (err as { name?: string }).name;
    const errCode = (err as { Code?: string }).Code;
    if (
      errName === 'ObjectLockConfigurationNotFoundError' ||
      errName === 'InvalidRequest' ||
      errCode === 'ObjectLockConfigurationNotFoundError' ||
      errCode === 'InvalidRequest'
    ) {
      return null;
    }
    throw err;
  }
}
