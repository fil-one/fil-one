import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { S3_REGION } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { NotImplementedError } from '../lib/errors.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  const { orgId } = getUserInfo(event);

  const orchestrator = getOrchestratorForRegion(S3_REGION);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({ message: 'Tenant setup is not complete, please try again later' })
      .build();
  }

  try {
    await orchestrator.deleteBucket(tenantId, bucketName);
  } catch (err) {
    if (err instanceof NotImplementedError) {
      return new ResponseBuilder()
        .status(501)
        .body<ErrorResponse>({ message: 'Bucket deletion is not yet supported for this region' })
        .build();
    }
    throw err;
  }

  return {
    statusCode: 204,
    body: '',
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
