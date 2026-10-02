import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEnablementResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION, SetBucketRagEnabledSchema, isSupportedRegion } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { ServiceOrchestrator } from '../lib/service-orchestrator.ts';
import { getOrgProfile, isOrgDeleting } from '../lib/org-profile.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import {
  getBucketRagEnablement,
  setBucketRagEnablement,
  toEnablementResponse,
} from '../lib/bucket-rag-enablement.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { scopedTo } from '../lib/member-scope.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware, requirePermission } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { ragAccessMiddleware } from '../middleware/rag-access.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * Refuse a bucket the caller cannot reach, or cannot index.
 *
 * A bucket the caller's tenant does not own is 404, as is one outside a scoped
 * member's policies. Turning indexing on also needs the member's policies to
 * grant listing and reading the bucket: the indexer lists and reads it with the
 * tenant's key, and the query path answers from that content. A region serving
 * scoped keys has no policies to consult.
 */
async function checkBucketReach(
  orchestrator: ServiceOrchestrator,
  tenantId: string,
  bucketName: string,
  { actAs, indexing }: { actAs: string | undefined; indexing: boolean },
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (!(await orchestrator.getBucket(tenantId, bucketName, { actAs }))) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }
  if (!indexing || !actAs || orchestrator.accessModel !== 'iam') return undefined;
  const access = await orchestrator.iam.resolveMemberAccess(tenantId, actAs);
  const actions = access.find((entry) => entry.bucketName === bucketName)?.actions ?? [];
  if (actions.includes('s3:ListBucket') && actions.includes('s3:GetObject')) return undefined;
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({ message: `Your access to ${bucketName} does not permit indexing it.` })
    .build();
}

/**
 * POST /api/buckets/{name}/rag/enabled — toggle a bucket's RAG indexing on/off
 * for the caller's tenant (FIL-555).
 *
 * Body: `{ enabled: boolean }`. Creates/updates the `BUCKET#{orgId}#{region}#{name}` / `RAG`
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

  // The requirement depends on the body, which is why the manifest marks this
  // route in-handler: turning indexing on is a bucket-configuration write and
  // sits with bucket creation, while turning it off discards the index and
  // sits with bucket deletion.
  const denied = enabled
    ? requirePermission(event, 'buckets.create', 'Your role does not permit indexing a bucket.')
    : requirePermission(
        event,
        'buckets.delete',
        'Your role does not permit discarding a bucket index.',
      );
  if (denied) return denied;

  const { orgId, userId, membership } = getUserInfo(event);

  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  const refused = await checkBucketReach(orchestrator, tenantId, bucketName, {
    actAs: scopedTo(membership?.role, userId),
    indexing: enabled,
  });
  if (refused) return refused;

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
  // Turning indexing on and off need different permissions, which only the body
  // says; membership is the same either way and is settled here.
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
