import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse, ListBucketsResponse, S3Region } from '@filone/shared';
import { listBucketsUnavailableMessage } from '@filone/shared';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { BucketSummary } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  const regions = await getProvisionedRegions(orgId);

  // Fail open (FIL-1049): one region's ListBuckets 403 used to collapse the whole request into a
  // generic 500, hiding the healthy regions' buckets. Return what answered, name what did not.
  const settled = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) => orchestrator.listBuckets(tenantId)),
  );

  const buckets: BucketSummary[] = [];
  const unavailableRegions: S3Region[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      buckets.push(...result.value);
      return;
    }
    const { orchestrator, tenantId } = regions[index];
    // The reason stays here: it carries orchestrator internals that must not reach the browser,
    // and an S3 AccessDenied string means nothing to a user. The client learns only the region.
    console.error('[list-buckets] Orchestrator listBuckets failed', {
      orgId,
      orchestratorId: orchestrator.id,
      region: orchestrator.region,
      tenantId,
      error: result.reason,
    });
    unavailableRegions.push(orchestrator.region);
  });

  // Every provisioned region is down: an empty 200 renders as "No buckets yet" over a real
  // outage. Returned rather than thrown so the message survives, since the error-handler
  // middleware replaces any throw with the generic 500. The `> 0` guard keeps an org with no
  // provisioned regions on the 200 path.
  if (unavailableRegions.length > 0 && unavailableRegions.length === regions.length) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({ message: listBucketsUnavailableMessage(unavailableRegions) })
      .build();
  }

  buckets.sort((a, b) => a.bucketName.localeCompare(b.bucketName));
  return new ResponseBuilder()
    .status(200)
    .body<ListBucketsResponse>({
      buckets,
      ...(unavailableRegions.length > 0 && { unavailableRegions }),
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
