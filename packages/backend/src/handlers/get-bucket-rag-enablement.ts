import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEnablementResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION, isReservedBucketName, isSupportedRegion } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import { getBucketRagEnablement, toEnablementResponse } from '../lib/bucket-rag-enablement.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

/**
 * GET /api/buckets/{name}/rag/enabled — read a bucket's RAG enablement state and
 * sync telemetry for the caller's tenant (FIL-555).
 *
 * Tenant-scoped: resolves the caller's tenant for the region and 404s when the
 * bucket is not owned by it (mirrors query-bucket). A bucket the tenant owns but
 * never enabled returns a graceful `{ enabled: false, status: 'disabled', ... }`
 * rather than a 404. RAG-gated by ragAccessMiddleware.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Bucket name is required' })
      .build();
  }

  // Reserved RAG companion index buckets (`filone-rag-*`) are Fil One internals.
  if (isReservedBucketName(bucketName)) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }

  const { orgId } = getUserInfo(event);

  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(process.env.FILONE_STAGE!, region, getVerifiedEmail(event))) {
    return unsupportedRegionResponse(region);
  }

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  // Enforce tenant/org scope: a bucket the caller's tenant does not own is 404.
  const bucket = await orchestrator.getBucket(tenantId, bucketName);
  if (!bucket) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }

  const record = await getBucketRagEnablement(orgId, region, bucketName);
  // Defense in depth: the org-scoped pk already prevents addressing another
  // org's row, but keep ignoring a record whose stamped org somehow differs.
  const owned = record && record.orgId === orgId ? record : undefined;

  return new ResponseBuilder()
    .status(200)
    .body<BucketRagEnablementResponse>(toEnablementResponse(owned))
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
