// Shared S3 client factory. Builds an S3Client from the S3ClientContext that
// the active ServiceOrchestrator supplies — the orchestrator alone knows how to
// look up credentials and which endpoint/region apply.

import { S3Client } from '@aws-sdk/client-s3';
import type { S3ClientContext } from './service-orchestrator.js';

export function createS3Client(ctx: S3ClientContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
  });
}
