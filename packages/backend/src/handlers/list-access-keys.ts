import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccessKey, ListAccessKeysResponse } from '@filone/shared';
import { effectiveActions, isSupportedRegion } from '@filone/shared';
import { getAccessKeysInScope } from '../lib/access-key-inventory.ts';
import { keyScope } from '../lib/key-scope.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import { ResponseBuilder, unsupportedRegionResponse } from '../lib/response-builder.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
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
  const inScope = await getAccessKeysInScope(orgId, keyScope(event), {
    bucketFilter,
    regionFilter,
  });
  const keys = bucketFilter
    ? await reachingBucket(inScope, { orgId, bucketName: bucketFilter, region: regionFilter })
    : inScope;

  return new ResponseBuilder().status(200).body<ListAccessKeysResponse>({ keys }).build();
}

/**
 * Which of the bucket-filtered rows reach the bucket. A service key answers
 * from its stored scope, which the query already applied. A principal-bound
 * key stores none: on a region serving the `iam` access model a member who can
 * see the bucket can act on it with their principal-bound key, so the key is
 * listed when the bucket's policy gives its principal any action. The policy is
 * read once per request; with no `iam` region to ask, or no policy on the
 * bucket, no principal-bound key reaches it.
 */
async function reachingBucket(
  keys: AccessKey[],
  { orgId, bucketName, region }: { orgId: string; bucketName: string; region?: string },
): Promise<AccessKey[]> {
  if (!keys.some((key) => key.type === 'principal')) return keys;
  const orchestrator =
    region && isSupportedRegion(region, process.env.FILONE_STAGE!)
      ? getOrchestratorForRegion(region)
      : undefined;
  if (orchestrator?.accessModel !== 'iam') return keys.filter((key) => key.type !== 'principal');
  // Read path: never provisions.
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  const stored = tenantId ? await orchestrator.iam.getBucketPolicy(tenantId, bucketName) : null;
  return keys.filter(
    (key) =>
      key.type !== 'principal' ||
      (stored !== null && effectiveActions(stored.policy, key.principalId).length > 0),
  );
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
