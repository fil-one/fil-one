import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type {
  BucketSortKey,
  ErrorResponse,
  ListBucketsResponse,
  S3Region,
  SortDirection,
} from '@filone/shared';
import { BUCKET_SORT_KEYS, listBucketsUnavailableMessage, SORT_DIRECTIONS } from '@filone/shared';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { BucketSummary } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';
import { filterBucketsByName, sortBuckets } from '../lib/bucket-list.js';

function parseSortKey(value: string | undefined): BucketSortKey {
  return BUCKET_SORT_KEYS.find((key) => key === value) ?? 'bucketName';
}

function parseSortDirection(value: string | undefined): SortDirection {
  return SORT_DIRECTIONS.find((direction) => direction === value) ?? 'asc';
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const { search, region } = event.queryStringParameters ?? {};
  const sortKey = parseSortKey(event.queryStringParameters?.sortKey);
  const sortDirection = parseSortDirection(event.queryStringParameters?.sortDirection);

  // Each orchestrator only ever serves its own fixed region, so a region filter
  // lets every other leg be skipped outright instead of fetched and discarded.
  const orchestrators = getAvailableOrchestrators().filter(
    (orchestrator) => !region || orchestrator.region === region,
  );
  const orgProfile = await getOrgProfile(orgId);

  // A not-ready orchestrator is simply absent from this org's provisioned regions, not a failed
  // leg: it must not be called, and it must not count toward the all-failed 503 below.
  const ready = orchestrators.flatMap((orchestrator) => {
    const tenantId = orchestrator.isTenantReady(orgProfile);
    return tenantId ? [{ orchestrator, tenantId }] : [];
  });

  // Fail open (FIL-1049): one region's ListBuckets 403 used to collapse the whole request into a
  // generic 500, hiding the healthy regions' buckets. Return what answered, name what did not.
  const settled = await Promise.allSettled(
    ready.map(({ orchestrator, tenantId }) => orchestrator.listBuckets(tenantId)),
  );

  const buckets: BucketSummary[] = [];
  const unavailableRegions: S3Region[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      buckets.push(...result.value);
      return;
    }
    const { orchestrator, tenantId } = ready[index];
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
  if (unavailableRegions.length > 0 && unavailableRegions.length === ready.length) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({ message: listBucketsUnavailableMessage(unavailableRegions) })
      .build();
  }

  const filtered = search ? filterBucketsByName(buckets, search) : buckets;
  const sorted = sortBuckets(filtered, sortKey, sortDirection);
  return new ResponseBuilder()
    .status(200)
    .body<ListBucketsResponse>({
      buckets: sorted,
      ...(unavailableRegions.length > 0 && { unavailableRegions }),
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.read'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
