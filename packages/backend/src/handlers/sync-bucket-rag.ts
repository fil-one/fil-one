import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse, RagEngineStatus } from '@filone/shared';
import { S3_REGION, isSupportedRegion, usesRagEngine } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { getOrgProfile, isOrgDeleting } from '../lib/org-profile.ts';
import {
  accountDeletedResponse,
  badRequestResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import { getBucketRagEnablement } from '../lib/bucket-rag-enablement.ts';
import { checkIndexingAccess } from '../lib/rag-indexing-access.ts';
import {
  browserSafeEngineStatus,
  getRagEngineClient,
  ragEngineErrorResponse,
  ragEngineTarget,
} from '../lib/rag-engine-client.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { ragAccessMiddleware } from '../middleware/rag-access.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * POST /api/buckets/{name}/rag/sync?region= — index a bucket now (FIL-1709).
 *
 * Forge regions only: asks the Bucket Intelligence engine to reconcile the
 * bucket's Lance dataset with its objects and answers 202 with the engine's
 * status. The engine runs one sync per bucket, so repeating the call while a
 * sync runs is harmless. Elsewhere indexing runs on the indexer's schedule and
 * this route answers 400. The bucket must have Bucket Intelligence turned on.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) return badRequestResponse('Bucket name is required');

  const { orgId, userId, membership } = getUserInfo(event);

  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }
  if (!usesRagEngine(region)) {
    return badRequestResponse('Indexing on demand is available only for buckets in Forge regions.');
  }

  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  const memberId = getScopedMemberId(membership?.role, userId);
  if (!(await orchestrator.getBucket(tenantId, { region, bucketName }, memberId))) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }
  // getBucket admits a member any policy names; a sync reads every object.
  const refused = await checkIndexingAccess(orchestrator, tenantId, bucketName, memberId);
  if (refused) return refused;

  const enablement = await getBucketRagEnablement(orgId, region, bucketName);
  if (!enablement || enablement.orgId !== orgId || enablement.status !== 'active') {
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: 'Turn on Bucket Intelligence for this bucket first.' })
      .build();
  }

  try {
    const client = getRagEngineClient();
    const target = await ragEngineTarget(orchestrator, tenantId, { orgId, region, bucketName });
    const status = await client.sync(target);
    return new ResponseBuilder()
      .status(202)
      .body<RagEngineStatus>(browserSafeEngineStatus(status))
      .build();
  } catch (error) {
    return ragEngineErrorResponse(error);
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // Indexing is a bucket-configuration write, gated like turning it on.
  .use(authorize('buckets.create'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
