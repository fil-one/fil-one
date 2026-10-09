import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  bucketPolicyErrorResponse,
  readPolicyPrecondition,
  resolveIamWriteTarget,
  resolvePolicyRouteTarget,
} from '../lib/bucket-policy-route.ts';
import { badRequestResponse } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * DELETE /api/buckets/{name}/policy?region= — remove the bucket's policy.
 *
 * As on S3, `If-Match` removes only the version the caller read, and a stale
 * one is a 412 with nothing removed; without it the delete is unconditional.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const resolved = resolvePolicyRouteTarget(event);
  if ('response' in resolved) return resolved.response;
  const { bucketName, region } = resolved.target;

  const read = readPolicyPrecondition(event);
  if ('response' in read) return read.response;
  const { precondition } = read;
  if (precondition && 'ifNoneMatch' in precondition) {
    return badRequestResponse('A delete cannot carry If-None-Match');
  }

  const { orgId, userId } = getUserInfo(event);
  const target = await resolveIamWriteTarget(orgId, region);
  if ('response' in target) return target.response;
  const { orchestrator, tenantId } = target;

  const audit = await twoPhaseAudit({
    type: 'bucket_policy.deleted',
    mode: 'fail-closed',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'policy_edit' },
  });

  try {
    await orchestrator.iam.deleteBucketPolicy(tenantId, bucketName, precondition);
    await audit.complete({ outcome: 'succeeded' });
    return { statusCode: 204, body: '' };
  } catch (err) {
    const response = bucketPolicyErrorResponse(err);
    if (!response) throw err;
    await audit.complete({ outcome: 'failed' });
    return response;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.policy_manage'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
