import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, isSupportedRegion, S3_REGION } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { getRequestDeadline, requestDeadlineMiddleware } from '../middleware/request-deadline.ts';
import { BucketNotEmptyError } from '../lib/errors.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import { ResponseBuilder, unsupportedRegionResponse } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const signal = getRequestDeadline(event);
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  const { orgId, userId } = getUserInfo(event);

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

  // Best-effort, as on create: an audit outage must not stop a bucket being
  // deleted.
  const bucketAudit = await twoPhaseAudit({
    type: 'bucket.deleted',
    mode: 'best-effort',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName },
  });

  try {
    await orchestrator.deleteBucket(tenantId, bucketName, { signal });
  } catch (err) {
    await bucketAudit.complete({ outcome: 'failed' });
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
  await bucketAudit.complete({ outcome: 'succeeded' });

  return {
    statusCode: 204,
    body: '',
  };
}

export const handler = middy(baseHandler)
  .use(requestDeadlineMiddleware())
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.delete'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
