import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketAnalyticsResponse } from '@filone/shared';
import { S3Region, isSupportedRegion } from '@filone/shared';
import { BucketNotFoundError } from '../lib/errors.js';
import { getOrgProfile } from '../lib/org-profile.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
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

  const region = event.queryStringParameters?.region ?? S3Region.EuWest1;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE)) {
    return unsupportedRegionResponse(region);
  }
  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  // getBucketUsageMetrics performs the tenant-scoped ownership check and throws
  // BucketNotFoundError when the bucket isn't owned by this tenant.
  let samples;
  try {
    samples = await orchestrator.getBucketUsageMetrics(tenantId, bucketName, {
      from: thirtyDaysAgo.toISOString(),
      to: now.toISOString(),
      interval: '1d',
    });
  } catch (err) {
    if (err instanceof BucketNotFoundError) {
      return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
    }
    throw err;
  }

  const latest = samples.at(-1);

  const response: BucketAnalyticsResponse = {
    objectCount: latest?.objectCount ?? 0,
    bytesUsed: latest?.bytesUsed ?? 0,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
