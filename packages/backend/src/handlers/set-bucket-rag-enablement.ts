import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketRagEnablementResponse, ErrorResponse } from '@filone/shared';
import {
  S3_REGION,
  SetBucketRagEnabledSchema,
  isReservedBucketName,
  isSupportedRegion,
} from '@filone/shared';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { companionBucketName } from '@filone/rag-shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { BucketAlreadyExistsError } from '../lib/errors.js';
import type { RagIndexerWorkerPayload } from '../jobs/rag-indexer-worker.js';
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
import type { BucketRAGEnablementRecord } from '../lib/dynamo-records.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const lambda = new LambdaClient({});

/**
 * On disable, async-invoke the indexer worker to tear the companion index down
 * (empty the companion bucket, drop manifest + checkpoint). Best-effort: the
 * `teardownPendingAt` marker was already persisted, so the indexer orchestrator
 * backstop retries a lost/failed invoke — never fail the user's disable on it.
 */
async function requestTeardown(orgId: string, region: string, bucketName: string): Promise<void> {
  const functionName = process.env.RAG_INDEXER_WORKER_FUNCTION_NAME;
  if (!functionName) {
    console.warn(
      '[set-bucket-rag-enablement] RAG_INDEXER_WORKER_FUNCTION_NAME unset; relying on the orchestrator backstop for teardown',
      { region, bucketName },
    );
    return;
  }
  const payload: RagIndexerWorkerPayload = {
    orgId,
    mode: 'teardown',
    buckets: [
      { region: region as RagIndexerWorkerPayload['buckets'][number]['region'], bucketName },
    ],
  };
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  } catch (error) {
    console.error(
      '[set-bucket-rag-enablement] Failed to invoke teardown worker; backstop will retry',
      { region, bucketName, error },
    );
  }
}

/**
 * On enable, idempotently provision the companion index bucket up front so
 * quota/name errors — e.g. the Aurora Portal `bucketLimit` — surface to the user
 * immediately rather than only later in the indexer. BucketAlreadyExistsError is
 * the expected steady state (swallowed); anything else propagates. The indexer's
 * ensureBucket remains the backstop.
 */
async function ensureCompanionBucket(
  orchestrator: ReturnType<typeof getOrchestratorForRegion>,
  tenantId: string,
  companionBucket: string,
): Promise<void> {
  try {
    await orchestrator.createBucket(tenantId, { bucketName: companionBucket });
  } catch (error) {
    if (!(error instanceof BucketAlreadyExistsError)) throw error;
  }
}

/**
 * Return the existing enablement record only when it belongs to the caller's
 * org. getBucket already proved tenant ownership, so an org mismatch here is a
 * data anomaly (stale/reused row) — logged for triage, then treated as no prior
 * record so setBucketRagEnablement re-stamps it with the correct org.
 */
function resolveOwnedRecord(
  existing: BucketRAGEnablementRecord | undefined,
  orgId: string,
  region: string,
  bucketName: string,
): BucketRAGEnablementRecord | undefined {
  const owned = existing && existing.orgId === orgId ? existing : undefined;
  if (existing && !owned) {
    console.warn(
      '[set-bucket-rag-enablement] RAG enablement row org mismatch; re-stamping with caller org',
      { region, bucketName, recordOrgId: existing.orgId, callerOrgId: orgId },
    );
  }
  return owned;
}

/**
 * POST /api/buckets/{name}/rag/enabled — toggle a bucket's RAG indexing on/off
 * for the caller's tenant (FIL-555).
 *
 * Body: `{ enabled: boolean }`. Creates/updates the `BUCKET#{region}#{name}` / `RAG`
 * enablement row, flipping `status` to `active`/`disabled` while preserving
 * telemetry and the original `createdAt`. On enable it also provisions the
 * per-bucket companion index bucket. Tenant-scoped (404 for buckets the tenant
 * does not own), RAG-gated, and Write-gated by the subscription guard.
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

  // A RAG companion index bucket (`filone-rag-*`) holds the index itself — you
  // cannot turn indexing on for it. Reject explicitly rather than 404 so the
  // reason is clear if one is ever addressed directly.
  if (isReservedBucketName(bucketName)) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Cannot enable indexing on an index bucket' })
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

  // On enable, provision the companion index bucket up front so quota/name
  // errors surface immediately (see ensureCompanionBucket).
  if (enabled) {
    await ensureCompanionBucket(
      orchestrator,
      tenantId,
      companionBucketName(orgId, region, bucketName),
    );
  }

  const existing = await getBucketRagEnablement(orgId, region, bucketName);
  const owned = resolveOwnedRecord(existing, orgId, region, bucketName);

  const record = await setBucketRagEnablement({
    region,
    bucketName,
    orgId,
    enabled,
    existing: owned,
  });

  // On disable, hand off companion teardown to the worker (async, best-effort).
  if (!enabled) {
    await requestTeardown(orgId, region, bucketName);
  }

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
