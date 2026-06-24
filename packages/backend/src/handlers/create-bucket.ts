import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { CreateBucketResponse, ErrorResponse } from '@filone/shared';
import { CreateBucketSchema, isSupportedRegion, GLOBAL_BUCKET_LIMIT } from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgResourceCounts } from '../lib/resource-helpers.js';
import {
  BucketAlreadyExistsError,
  BucketConfigurationError,
  ResourceCountUnavailableError,
} from '../lib/errors.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = CreateBucketSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: firstIssue.message })
      .build();
  }

  const { bucketName, region, versioning, lock, retention } = parsed.data;

  const { orgId } = getUserInfo(event);

  if (!isSupportedRegion(process.env.FILONE_STAGE!, region, getVerifiedEmail(event))) {
    return unsupportedRegionResponse(region);
  }

  let bucketCount: number;
  try {
    ({ bucketCount } = await getOrgResourceCounts(orgId));
  } catch (err) {
    // Fail closed: if we can't read the global count, refuse rather than risk
    // letting the org exceed its limit. 503 tells the caller to retry.
    if (err instanceof ResourceCountUnavailableError) {
      return new ResponseBuilder()
        .status(503)
        .body<ErrorResponse>({
          message:
            'We could not verify your account limits right now. Please try again in a moment.',
        })
        .build();
    }
    throw err;
  }
  if (bucketCount >= GLOBAL_BUCKET_LIMIT) {
    return new ResponseBuilder()
      .status(403)
      .body<ErrorResponse>({
        message: `Bucket limit reached. You can create up to ${GLOBAL_BUCKET_LIMIT} buckets.`,
      })
      .build();
  }

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return tenantNotReadyResponse();

  try {
    await orchestrator.createBucket(tenantId, {
      bucketName,
      versioning,
      lock,
      retention,
    });
  } catch (err) {
    if (err instanceof BucketAlreadyExistsError) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: `Bucket "${bucketName}" already exists` })
        .build();
    }
    // The bucket was created but couldn't be fully configured. Surface the
    // actionable message so the caller can finish setup via the S3 API instead
    // of getting the generic 500 from errorHandlerMiddleware.
    if (err instanceof BucketConfigurationError) {
      return new ResponseBuilder()
        .status(500)
        .body<ErrorResponse>({ message: err.message })
        .build();
    }
    throw err;
  }

  const now = new Date().toISOString();

  return new ResponseBuilder()
    .status(201)
    .body<CreateBucketResponse>({
      bucket: {
        bucketName,
        region,
        createdAt: now,
        isPublic: false,
      },
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
