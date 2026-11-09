import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEnablementResponse, ErrorResponse, S3Region } from '@filone/shared';
import {
  S3_REGION,
  SetBucketRagEnabledSchema,
  isSupportedRegion,
  usesRagEngine,
} from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { RegionOrchestrator } from '../lib/service-orchestrator.ts';
import { checkIndexingAccess } from '../lib/rag-indexing-access.ts';
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
import {
  getRagEngineConfig,
  getRagEngineClient,
  ragEngineErrorResponse,
  ragEngineTarget,
  RagEngineNotConfiguredError,
  withEngineFailure,
  withEngineStatus,
} from '../lib/rag-engine-client.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware, requirePermission } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { ragAccessMiddleware } from '../middleware/rag-access.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/** The `{ enabled }` body, or the 400 that says what is wrong with it. */
function parseEnabledBody(
  event: AuthenticatedEvent,
): { enabled: boolean } | { response: APIGatewayProxyStructuredResultV2 } {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      response: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: 'Invalid JSON body' })
        .build(),
    };
  }
  const parsed = SetBucketRagEnabledSchema.safeParse(body);
  if (!parsed.success) {
    return {
      response: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: parsed.error.issues[0].message })
        .build(),
    };
  }
  return { enabled: parsed.data.enabled };
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

  const parsedBody = parseEnabledBody(event);
  if ('response' in parsedBody) return parsedBody.response;
  const { enabled } = parsedBody;

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

  const memberId = getScopedMemberId(membership?.role, userId);
  // Enforce tenant/org scope: a bucket the caller's tenant does not own, or a
  // scoped member cannot reach, is 404.
  if (!(await orchestrator.getBucket(tenantId, { region, bucketName }, memberId))) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }
  const refused = enabled
    ? await checkCanIndex({ orchestrator, tenantId, bucketName, memberId, region })
    : undefined;
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

  const response = await startEngineSync(toEnablementResponse(record), orchestrator, tenantId, {
    orgId,
    region,
    bucketName,
    enabled,
  });

  return new ResponseBuilder().status(200).body<BucketRagEnablementResponse>(response).build();
}

/** Why this bucket cannot be indexed for this caller, or undefined when it can. */
async function checkCanIndex(args: {
  orchestrator: RegionOrchestrator;
  tenantId: string;
  bucketName: string;
  memberId: string | undefined;
  region: S3Region;
}): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const { orchestrator, tenantId, bucketName, memberId, region } = args;
  return (
    refuseWithoutEngine(region) ??
    (await checkIndexingAccess(orchestrator, tenantId, bucketName, memberId))
  );
}

/**
 * Forge regions index on the engine. Without one on this stage, turning
 * indexing on would record a bucket nothing can ever index: 503 instead.
 */
function refuseWithoutEngine(region: S3Region): APIGatewayProxyStructuredResultV2 | undefined {
  if (!usesRagEngine(region) || getRagEngineConfig()) return undefined;
  return ragEngineErrorResponse(new RagEngineNotConfiguredError());
}

/**
 * Forge regions, when indexing is turned on: the first index starts now rather
 * than at the next indexer pass. The row is already written, so an engine
 * failure is reported as a failed sync and the indexer's next pass retries it.
 * Every other case returns the response unchanged.
 */
async function startEngineSync(
  response: BucketRagEnablementResponse,
  orchestrator: RegionOrchestrator,
  tenantId: string,
  bucket: { orgId: string; region: S3Region; bucketName: string; enabled: boolean },
): Promise<BucketRagEnablementResponse> {
  if (!bucket.enabled || !usesRagEngine(bucket.region)) return response;
  try {
    const target = await ragEngineTarget(orchestrator, tenantId, bucket);
    return withEngineStatus(response, await getRagEngineClient().sync(target));
  } catch (error) {
    console.error('[set-bucket-rag-enablement] engine sync failed', {
      region: bucket.region,
      bucketName: bucket.bucketName,
      error: error instanceof Error ? error.message : String(error),
    });
    return withEngineFailure(response, error);
  }
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
