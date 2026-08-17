// Starts a bulk deletion of a bucket's objects and hands the work to the
// bulk-delete worker. Returns immediately with a job the client can poll, since
// a large bucket takes far longer than a request can stay open.

import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import {
  CreateBulkDeleteJobSchema,
  S3Region,
  isSupportedRegion,
  type CreateBulkDeleteJobResponse,
  type ErrorResponse,
} from '@filone/shared';

import {
  BulkDeleteJobExistsError,
  createBulkDeleteJob,
  failJob,
  putBulkDeleteJob,
  toApiJob,
} from '../lib/bulk-delete-jobs.js';
import { enqueueBulkDeleteJob } from '../lib/bulk-delete-queue.js';
import { getOrgProfile } from '../lib/org-profile.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
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
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
