// Starts a bulk deletion of a bucket's objects and hands the work to the
// bulk-delete worker. Returns immediately with a job the client can poll, since
// a large bucket takes far longer than a request can stay open.

import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import {
  BulkDeleteScope,
  CreateBulkDeleteJobSchema,
  S3Region,
  isSupportedRegion,
  supportsIamMethods,
  type CreateBulkDeleteJobResponse,
  type ErrorResponse,
  type PolicyAction,
} from '@filone/shared';

import {
  BulkDeleteJobExistsError,
  createBulkDeleteJob,
  failJob,
  putBulkDeleteJob,
  toApiJob,
} from '../lib/bulk-delete-jobs.ts';
import { enqueueBulkDeleteJob } from '../lib/bulk-delete-queue.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { RegionOrchestrator, ServiceOrchestrator } from '../lib/service-orchestrator.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * The policy actions the worker's S3 calls need for each scope. An all-versions
 * delete lists versions and deletes by version id, except on a bucket that never
 * enabled versioning, where it issues plain object deletes.
 */
const SCOPE_ACTIONS: Record<BulkDeleteScope, PolicyAction[]> = {
  [BulkDeleteScope.Current]: ['s3:ListBucket', 's3:DeleteObject'],
  [BulkDeleteScope.AllVersions]: [
    's3:ListBucketVersions',
    's3:DeleteObject',
    's3:DeleteObjectVersion',
  ],
};

/**
 * Refuse a scoped member whose bucket policies do not cover the deletion.
 *
 * The worker deletes with the tenant's key, which the storage system never
 * evaluates a policy for, so this check is the whole enforcement. A bucket
 * outside the member's policies answers like a bucket that does not exist, since
 * a distinct code would confirm it exists. An unscoped caller, and every region
 * serving service keys, skips the read.
 */
async function checkMemberBucketAccess(
  orchestrator: RegionOrchestrator,
  tenantId: string,
  memberId: string | undefined,
  { bucketName, scope }: { bucketName: string; scope: BulkDeleteScope },
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (!memberId || !supportsIamMethods(orchestrator.region)) return undefined;
  // Every region serving the iam access model has a ServiceOrchestrator, which
  // the compiler cannot tell from the region check.
  const access = await (orchestrator as ServiceOrchestrator).resolveMemberAccess(
    tenantId,
    memberId,
  );
  const granted = access.find((entry) => entry.bucketName === bucketName)?.actions;
  if (!granted) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }
  if (!SCOPE_ACTIONS[scope].every((action) => granted.includes(action))) {
    return new ResponseBuilder()
      .status(403)
      .body<ErrorResponse>({
        message: `Your access to ${bucketName} does not permit bulk deletion.`,
      })
      .build();
  }
  return undefined;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, membership } = getUserInfo(event);
  const bucketName = event.pathParameters?.name;

  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Bucket name is required' })
      .build();
  }

  const region = event.queryStringParameters?.region ?? S3Region.EuWest1;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
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

  const parsed = CreateBulkDeleteJobSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  const { prefix, scope, idempotencyKey } = parsed.data;

  const accessRefused = await checkMemberBucketAccess(
    orchestrator,
    tenantId,
    getScopedMemberId(membership?.role, userId),
    { bucketName, scope },
  );
  if (accessRefused) return accessRefused;

  // The job id is derived from the request (bucket, prefix, scope and the
  // idempotency key), so a resubmit of the same request lands on the existing
  // row instead of starting a second deletion. See deriveBulkDeleteJobId.
  try {
    const job = await createBulkDeleteJob({
      idempotencyKey,
      orgId,
      region,
      bucketName,
      prefix,
      scope,
    });

    try {
      // Sequence 0 is the job's first message; the worker's hand-offs take it
      // from there. See enqueueBulkDeleteJob.
      await enqueueBulkDeleteJob({ orgId, jobId: job.jobId }, 0);
    } catch (err) {
      // The row exists but nothing will ever pick it up, so record that rather
      // than leaving a job the UI polls forever.
      await putBulkDeleteJob(failJob(job, 'Could not queue the deletion job'));
      throw err;
    }

    return new ResponseBuilder()
      .status(202)
      .body<CreateBulkDeleteJobResponse>({ job: toApiJob(job) })
      .build();
  } catch (err) {
    if (err instanceof BulkDeleteJobExistsError) {
      // Same request arriving twice: hand back the job already running.
      return new ResponseBuilder()
        .status(200)
        .body<CreateBulkDeleteJobResponse>({ job: toApiJob(err.job) })
        .build();
    }
    throw err;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('objects.delete'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
