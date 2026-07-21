// Shared S3 client factory. Builds an S3Client from the S3ClientContext that
// the active ServiceOrchestrator supplies — the orchestrator alone knows how to
// look up credentials and which endpoint/region apply.

import { S3Client } from '@aws-sdk/client-s3';

export interface S3ClientContext {
  endpointUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle: boolean;
  /** Which orchestrator issued this context — for error decoration only. */
  orchestratorId: string;
  /** Whose credentials the client acts with — for error decoration only. */
  tenantId: string;
}

export function createS3Client(ctx: S3ClientContext): S3Client {
  const client = new S3Client({
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

  // Decorate every S3 failure with the operation, bucket, and tenant context,
  // so an error escaping to the top-level handler still tells us which
  // provider/tenant/bucket it came from.
  client.middlewareStack.add(
    (next, handlerContext) => async (args) => {
      try {
        return await next(args);
      } catch (err) {
        throw decorateS3Error(err, ctx, handlerContext.commandName, args.input);
      }
    },
    { step: 'initialize', name: 's3ErrorContextMiddleware' },
  );

  return client;
}

// Decorates the error in place (rather than wrapping it in a new Error) so
// callers' `err.name` and `instanceof` checks keep working.
function decorateS3Error(
  err: unknown,
  ctx: S3ClientContext,
  commandName: string | undefined,
  input: unknown,
): unknown {
  if (!(err instanceof Error)) return err;

  const operation = commandName?.replace(/Command$/, '') ?? 'unknown';
  const bucketName = (input as { Bucket?: string } | undefined)?.Bucket;
  const context =
    `(operation=${operation}, ${bucketName ? `bucket=${bucketName}, ` : ''}` +
    `tenant=${ctx.tenantId}, orchestrator=${ctx.orchestratorId}, ` +
    `region=${ctx.region}, endpoint=${ctx.endpointUrl})`;

  err.message = `${err.message}\n${context}`;
  return err;
}
