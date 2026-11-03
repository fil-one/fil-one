import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEngineResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION, isSupportedRegion, usesRagEngine } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import {
  badRequestResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import {
  getRagEngineClient,
  ragEngineErrorResponse,
  ragEngineTarget,
} from '../lib/rag-engine-client.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { ragAccessMiddleware } from '../middleware/rag-access.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * GET /api/buckets/{name}/rag/engine?region= — the Bucket Intelligence engine's
 * view of a bucket (FIL-1709): sync status and progress, the Lance dataset on
 * Forge storage, and its version history newest first.
 *
 * Forge regions only; elsewhere the index lives in S3 Vectors and this route
 * answers 400.
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
    return badRequestResponse(
      'The index engine view is available only for buckets in Forge regions.',
    );
  }

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  if (
    !(await orchestrator.getBucket(
      tenantId,
      bucketName,
      getScopedMemberId(membership?.role, userId),
    ))
  ) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }

  try {
    const client = getRagEngineClient();
    const target = await ragEngineTarget(orchestrator, tenantId, { orgId, region, bucketName });
    const [status, { versions }] = await Promise.all([
      client.status(target),
      client.versions(target),
    ]);
    return new ResponseBuilder()
      .status(200)
      .body<BucketRagEngineResponse>({ status, versions })
      .build();
  } catch (error) {
    return ragEngineErrorResponse(error);
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.read'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
