import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket, ListBucketsResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator/service-orchestrator-registry.js';
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

  const orchestrator = getOrchestratorForRegion(S3_REGION);
  const ready = await orchestrator.isTenantReady(orgId);
  if (!ready) {
    return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets: [] }).build();
  }

  const summaries = await orchestrator.listBuckets(ready.tenantId);

  const buckets: Bucket[] = summaries.map((b) => ({
    name: b.name,
    region: orchestrator.region,
    createdAt: b.createdAt,
    isPublic: false,
    versioning: b.versioning ?? false,
    encrypted: b.encrypted ?? true,
  }));

  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
