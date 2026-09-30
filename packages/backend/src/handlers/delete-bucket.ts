import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, isSupportedRegion, S3_REGION } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { ORCHESTRATOR_REQUEST_TIMEOUT_MS } from '../lib/service-orchestrator.ts';
import { BucketNotEmptyError } from '../lib/errors.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import { ResponseBuilder, unsupportedRegionResponse } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

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

  // The bucket's own region, as every other bucket-addressed route reads it.
  // Hardcoding the default sent every delete to Aurora: a bucket in another
  // region answered `Forbidden` there, and an org with no Aurora tenant was
  // told its setup was incomplete for a region it had not asked about.
  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }
  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({ message: 'Tenant setup is not complete, please try again later' })
      .build();
  }

  try {
    await orchestrator.deleteBucket(tenantId, bucketName, {
      signal: AbortSignal.timeout(ORCHESTRATOR_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof BucketNotEmptyError) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({
          message: `Bucket "${bucketName}" is not empty. Delete its objects and object versions before deleting the bucket.`,
          code: ApiErrorCode.BUCKET_NOT_EMPTY,
        })
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
  .use(authorize('buckets.delete'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
