import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListBucketsResponse } from '@filone/shared';
import type { BucketSummary } from '../lib/service-orchestrator.js';
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

  const firstRejection = settled.findIndex((result) => result.status === 'rejected');
  if (firstRejection !== -1) {
    for (const [index, result] of settled.entries()) {
      if (result.status !== 'rejected') continue;
      const orchestrator = orchestrators[index];
      console.error('[list-buckets] Orchestrator listBuckets failed', {
        orgId,
        orchestratorId: orchestrator.id,
        region: orchestrator.region,
        error: result.reason,
      });
    }
    throw (settled[firstRejection] as PromiseRejectedResult).reason;
  }

  const results = settled.map(
    (result) => (result as PromiseFulfilledResult<BucketSummary[]>).value,
  );
  const buckets = results.flat().sort((a, b) => a.bucketName.localeCompare(b.bucketName));
  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
