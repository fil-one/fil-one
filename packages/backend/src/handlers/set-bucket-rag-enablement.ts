import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEnablementResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION, SetBucketRagEnabledSchema, isSupportedRegion } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import {
  getBucketRagEnablement,
  setBucketRagEnablement,
  toEnablementResponse,
} from '../lib/bucket-rag-enablement.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

/**
 * POST /api/buckets/{name}/rag/enabled — toggle a bucket's RAG indexing on/off
 * for the caller's tenant (FIL-555).
 *
 * Body: `{ enabled: boolean }`. Creates/updates the `BUCKET#{region}#{name}` / `RAG`
 * enablement row, flipping `status` to `active`/`disabled` while preserving
 * telemetry and the original `createdAt`. Tenant-scoped (404 for buckets the
 * tenant does not own), RAG-gated, and Write-gated by the subscription guard.
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

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = SetBucketRagEnabledSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }
  const { enabled } = parsed.data;

  const { orgId } = getUserInfo(event);

  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(region)) {
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

  const existing = await getBucketRagEnablement(orgId, region, bucketName);
  // Defense in depth: never carry over a record stamped with a different org.
  // getBucket already proved tenant ownership, so a mismatch here is a data
  // anomaly (stale/reused row), not a client error — re-stamp the row with the
  // correct org rather than rejecting the caller, but surface it for triage.
  const owned = existing && existing.orgId === orgId ? existing : undefined;
  if (existing && !owned) {
    console.warn(
      '[set-bucket-rag-enablement] RAG enablement row org mismatch; re-stamping with caller org',
      { region, bucketName, recordOrgId: existing.orgId, callerOrgId: orgId },
    );
  }

  const record = await setBucketRagEnablement({
    region,
    bucketName,
    orgId,
    enabled,
    existing: owned,
  });

  return new ResponseBuilder()
    .status(200)
    .body<BucketRagEnablementResponse>(toEnablementResponse(record))
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
