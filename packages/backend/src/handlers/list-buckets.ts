import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type {
  BucketSortKey,
  ErrorResponse,
  ListBucketsResponse,
  SortDirection,
} from '@filone/shared';
import { BUCKET_SORT_KEYS, listBucketsUnavailableMessage, SORT_DIRECTIONS } from '@filone/shared';
import { listOrgBuckets } from '../lib/list-org-buckets.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { getRequestDeadline, requestDeadlineMiddleware } from '../middleware/request-deadline.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';
import { filterBucketsByName, sortBuckets } from '../lib/bucket-list.ts';

function parseSortKey(value: string | undefined): BucketSortKey {
  return BUCKET_SORT_KEYS.find((key) => key === value) ?? 'bucketName';
}

function parseSortDirection(value: string | undefined): SortDirection {
  return SORT_DIRECTIONS.find((direction) => direction === value) ?? 'asc';
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, membership } = getUserInfo(event);
  const { search, region } = event.queryStringParameters ?? {};
  const sortKey = parseSortKey(event.queryStringParameters?.sortKey);
  const sortDirection = parseSortDirection(event.queryStringParameters?.sortDirection);
  // One deadline for every leg of the fan-out. A hung region then fails
  // its own leg and is named in the response, instead of holding the whole
  // handler until the Lambda timeout kills it with nothing logged.
  const signal = getRequestDeadline(event);
  const { buckets, unavailableRegions, allFailed } = await listOrgBuckets(
    { orgId, userId, membership },
    { region, signal },
  );

  // An empty 200 would render as "No buckets yet" over a real outage. Returned
  // rather than thrown so the message survives, since the error-handler
  // middleware replaces any throw with the generic 500.
  if (allFailed) {
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
  .use(requestDeadlineMiddleware())
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.read'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
