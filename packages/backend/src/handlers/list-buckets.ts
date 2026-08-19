import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketSortKey, ListBucketsResponse, SortDirection } from '@filone/shared';
import { BUCKET_SORT_KEYS, SORT_DIRECTIONS } from '@filone/shared';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
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
  // `allSettled` rather than `all` so every failing leg can be named in the logs and carried in
  // the rethrown error: `all` discards which orchestrator rejected, which leaves a 500 here
  // indistinguishable between regions. We wait for every leg to settle, log each failure, then
  // rethrow them together as one AggregateError in registry order. The request still fails as
  // a whole.
  const settled = await Promise.allSettled(
    orchestrators.map(async (orchestrator) => {
      const tenantId = orchestrator.isTenantReady(orgProfile);
      if (!tenantId) return [];
      return orchestrator.listBuckets(tenantId);
    }),
  );

  // Pair each rejection with the orchestrator that produced it, in registry order, so the
  // logging and the rethrow below both work off that one collection.
  const failures = settled.flatMap((result, index) =>
    result.status === 'rejected'
      ? { orchestrator: orchestrators[index], reason: result.reason }
      : [],
  );

  if (failures.length > 0) {
    for (const { orchestrator, reason } of failures) {
      console.error('[list-buckets] Orchestrator listBuckets failed', {
        orgId,
        orchestratorId: orchestrator.id,
        region: orchestrator.region,
        error: reason,
      });
    }
    // Name every failing leg in the top-level message too: AggregateError hides the nested
    // `errors` from most log formatters, so without this a 500 says nothing about the cause.
    const legs = failures.map(
      ({ orchestrator, reason }) =>
        `${orchestrator.id} (${orchestrator.region}): ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    throw new AggregateError(
      failures.map(({ reason }) => reason),
      `One or more orchestrators failed to list buckets:\n${legs.join('\n')}`,
    );
  }

  const fetched = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  const filtered = search ? filterBucketsByName(fetched, search) : fetched;
  const buckets = sortBuckets(filtered, sortKey, sortDirection);
  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
