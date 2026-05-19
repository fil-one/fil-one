import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket, GetBucketResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { orchestratorForRegion } from '../lib/service-orchestrator/registry.js';
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

  const orchestrator = orchestratorForRegion(S3_REGION);
  const ready = await orchestrator.isTenantReady(orgId);
  if (!ready) {
    return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
  }

  const details = await orchestrator.getBucket(ready.tenantId, bucketName);
  if (!details) {
    return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
  }

  const bucket: Bucket = {
    name: details.name,
    region: orchestrator.region,
    createdAt: details.createdAt,
    isPublic: false,
    objectLockEnabled: details.objectLockEnabled ?? false,
    versioning: details.versioning ?? false,
    encrypted: details.encrypted ?? true,
    defaultRetention: details.defaultRetention,
    retentionDuration: details.retentionDuration,
    retentionDurationType: details.retentionDurationType,
  };

  return new ResponseBuilder().status(200).body<GetBucketResponse>({ bucket }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
