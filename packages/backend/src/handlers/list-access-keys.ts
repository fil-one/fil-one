import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListAccessKeysResponse } from '@filone/shared';
import { isSupportedRegion } from '@filone/shared';
import { getAccessKeysInScope } from '../lib/access-key-inventory.ts';
import { keyScope } from '../lib/key-scope.ts';
import { ResponseBuilder, unsupportedRegionResponse } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const bucketFilter = event.queryStringParameters?.bucket;
  // Optional: callers that omit `region` get keys from every region, which is what
  // the API keys page lists.
  const regionFilter = event.queryStringParameters?.region;

  if (regionFilter && !isSupportedRegion(regionFilter, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(regionFilter);
  }

  // A caller holding only `keys.manage_own` sees the keys they created and
  // nothing else. See `getAccessKeysInScope` for the query and the mapping to
  // `AccessKey`, shared with the dashboard's key count.
  const keys = await getAccessKeysInScope(orgId, keyScope(event), { bucketFilter, regionFilter });

  return new ResponseBuilder().status(200).body<ListAccessKeysResponse>({ keys }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
