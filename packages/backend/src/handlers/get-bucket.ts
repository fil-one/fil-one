import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GetBucketResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const bucketName = event.pathParameters?.name;

  if (!bucketName) {
    return new ResponseBuilder().status(400).body({ message: 'Bucket name is required' }).build();
  }

  const orchestrator = getOrchestratorForRegion(S3_REGION);
  const tenantId = await orchestrator.isTenantReady(orgId);
  if (!tenantId) {
    return new ResponseBuilder()
      .status(503)
      .body({ message: 'Tenant setup is not complete, please try again later' })
      .build();
  }

  const bucket = await orchestrator.getBucket(tenantId, bucketName);
  if (!bucket) {
    return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
  }

  return new ResponseBuilder().status(200).body<GetBucketResponse>({ bucket }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
