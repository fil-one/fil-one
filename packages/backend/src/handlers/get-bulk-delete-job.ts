// Returns the current state of a bulk-delete job so the client can poll it to
// completion. Read-only: the job id is scoped to the caller's org by the
// partition key, so one org can never read another's job.

import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import type { ErrorResponse, GetBulkDeleteJobResponse } from '@filone/shared';

import { getBulkDeleteJob, toApiJob } from '../lib/bulk-delete-jobs.js';
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
  const jobId = event.pathParameters?.jobId;

  if (!jobId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Job id is required' })
      .build();
  }

  const job = await getBulkDeleteJob(orgId, jobId);
  if (!job) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Job not found' })
      .build();
  }

  return new ResponseBuilder()
    .status(200)
    .body<GetBulkDeleteJobResponse>({ job: toApiJob(job) })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
