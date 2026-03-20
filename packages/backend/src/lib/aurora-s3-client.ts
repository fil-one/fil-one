import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3Object } from '@filone/shared';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export interface AuroraS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export async function getAuroraS3Credentials(
  stage: string,
  tenantId: string,
): Promise<AuroraS3Credentials> {
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

  return JSON.parse(value) as AuroraS3Credentials;
}

export interface PresignPutObjectOptions {
  endpointUrl: string;
  credentials: AuroraS3Credentials;
  bucket: string;
  key: string;
  expiresIn: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export async function getPresignedPutObjectUrl(options: PresignPutObjectOptions): Promise<string> {
  const { endpointUrl, credentials, bucket, key, expiresIn, contentType, metadata } = options;

  const s3 = new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

  console.log('[aurora-s3] Creating presigned PutObject URL', {
    endpoint: endpointUrl,
    bucket,
    key,
    accessKeyId: credentials.accessKeyId,
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
  endpointUrl: string;
  credentials: AuroraS3Credentials;
  bucket: string;
  key: string;
  expiresIn: number;
}

export async function getPresignedGetObjectUrl(options: PresignGetObjectOptions): Promise<string> {
  const { endpointUrl, credentials, bucket, key, expiresIn } = options;

  const s3 = new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

  console.log('[aurora-s3] Creating presigned GetObject URL', {
    endpoint: endpointUrl,
    bucket,
    key,
    accessKeyId: credentials.accessKeyId,
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

export async function deleteObject(
  endpointUrl: string,
  credentials: AuroraS3Credentials,
  bucket: string,
  key: string,
): Promise<void> {
  const s3 = new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

  console.log('[aurora-s3] Deleting object', {
    endpoint: endpointUrl,
    bucket,
    key,
    accessKeyId: credentials.accessKeyId,
  });

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
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

  const s3 = new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

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
