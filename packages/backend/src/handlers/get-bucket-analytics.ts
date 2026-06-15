import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketAnalyticsResponse, ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getProvisionedRegions } from '../lib/region-helpers.js';
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

  // A bucket lives in exactly one region; resolve every provisioned region and
  // find the orchestrator that owns it.
  const regions = await getProvisionedRegions(orgId);
  if (regions.length === 0) {
    console.error('No provisioned regions for org', { orgId });
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Tenant setup is not complete, please try again later',
      })
      .build();
  }

  // getBucket doubles as the ownership check: only the owning tenant's
  // orchestrator returns a non-null bucket.
  const owners = await Promise.all(
    regions.map(async ({ orchestrator, tenantId }) => {
      const bucket = await orchestrator.getBucket(tenantId, bucketName);
      return bucket ? { orchestrator, tenantId } : null;
    }),
  );
  const owner = owners.find((o) => o !== null);

  if (!owner) {
    return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const samples = await owner.orchestrator.getBucketUsageMetrics(owner.tenantId, bucketName, {
    from: thirtyDaysAgo.toISOString(),
    to: now.toISOString(),
    interval: '1d',
  });

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
