// Shared S3 client factory. Builds an S3Client from the S3ClientContext that
// the active ServiceOrchestrator supplies — the orchestrator alone knows how to
// look up credentials and which endpoint/region apply.

import { S3Client } from '@aws-sdk/client-s3';

export interface S3ClientContext {
  endpointUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle: boolean;
}

export function createS3Client(ctx: S3ClientContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
    // Restore pre-v3.729 behavior: do not auto-add CRC32 checksum params.
    // Without this, presigned PutObject URLs carry x-amz-checksum-crc32
    // (computed over an empty body at presign time) and x-amz-sdk-checksum-
    // algorithm in the signed query string. The browser then uploads the real
    // bytes without a matching checksum, so the gateway returns 400 BadDigest.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
