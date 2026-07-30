import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListBucketsResponse } from '@filone/shared';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
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

  const orchestrators = getAvailableOrchestrators();
  const orgProfile = await getOrgProfile(orgId);
  // `allSettled` rather than `all` purely so a failing leg can be named in the logs before
  // it is rethrown: `all` discards which orchestrator rejected, which leaves a 500 here
  // indistinguishable between regions. Behaviour is unchanged — the first rejection still
  // propagates and the request still fails as a whole.
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
    throw failures[0].reason;
  }

  const buckets = settled
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((a, b) => a.bucketName.localeCompare(b.bucketName));
  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
