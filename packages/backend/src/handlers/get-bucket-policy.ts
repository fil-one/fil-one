import middy from '@middy/core';
import { supportsBucketPolicies } from '../lib/service-orchestrator.ts';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GetBucketPolicyResponse } from '@filone/shared';
import {
  POLICIES_UNAVAILABLE_MESSAGE,
  toPolicyErrorResponse,
  policyNotFoundResponse,
  resolvePolicyRouteTarget,
} from '../lib/bucket-policy-route.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import { ResponseBuilder, tenantNotReadyResponse } from '../lib/response-builder.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * GET /api/buckets/{name}/policy?region= — the bucket's policy, with the ETag
 * its next write sends back in `If-Match` as the `ETag` header.
 *
 * Reading takes `buckets.policy_manage`, the same permission as editing: a
 * member learns their own reach from the bucket list, and the document names
 * other people. A bucket with no policy is a 404 carrying `POLICY_NOT_FOUND`, so
 * the console can offer to write the first statement; a bucket that is not
 * there is a plain 404.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const routeTarget = resolvePolicyRouteTarget(event);
  if ('response' in routeTarget) return routeTarget.response;
  const { bucketName, region } = routeTarget.target;

  const orchestrator = getOrchestratorForRegion(region);
  if (!supportsBucketPolicies(orchestrator)) {
    return policyNotFoundResponse(POLICIES_UNAVAILABLE_MESSAGE);
  }

  const { orgId } = getUserInfo(event);
  // isTenantReady rather than ensureTenantReady: a read must not create a tenant.
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  try {
    const stored = await orchestrator.getBucketPolicy(tenantId, bucketName);
    if (!stored) return policyNotFoundResponse();
    return new ResponseBuilder()
      .status(200)
      .header('ETag', stored.etag)
      .body<GetBucketPolicyResponse>({ policy: stored.policy })
      .build();
  } catch (err) {
    const response = toPolicyErrorResponse(err);
    if (!response) throw err;
    return response;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.policy_manage'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
