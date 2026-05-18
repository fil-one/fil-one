import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { S3_REGION } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { orchestratorForRegion } from '../lib/service-orchestrator/registry.js';
import { listObjects } from '../lib/service-orchestrator/s3-presigner.js';
import { tenantNotReadyResponse } from '../lib/tenant-not-ready-response.js';
import { isNoSuchBucketError } from '../lib/s3-errors.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  const { orgId } = getUserInfo(event);

  const orchestrator = orchestratorForRegion(S3_REGION);
  const ready = await orchestrator.ensureTenantReady(orgId);
  if (!ready.ok) return tenantNotReadyResponse(ready.reason);

  const ctx = await orchestrator.getPresignerContext(ready.tenantId);

  try {
    const objects = await listObjects({ ctx, bucket: bucketName, maxKeys: 1 });

    if (objects.objects.length > 0) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: 'Bucket must be empty before deletion' })
        .build();
    }

    await orchestrator.deleteBucket(ready.tenantId, bucketName);
  } catch (err) {
    if (isNoSuchBucketError(err)) {
      return new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Bucket not found' })
        .build();
    }
    throw err;
  }

  return {
    statusCode: 204,
    body: '',
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
