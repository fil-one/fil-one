import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  bucketPolicyErrorResponse,
  resolveIamWriteTarget,
  resolvePolicyRouteTarget,
} from '../lib/bucket-policy-route.ts';
import { badRequestResponse, ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * DELETE /api/buckets/{name}/policy?region=&etag= — remove the bucket's policy.
 *
 * The ETag travels as a query parameter rather than an `If-Match` header: the
 * API's CORS allowlist names its headers one by one, and a body on a DELETE is
 * the shape proxies drop. A missing ETag is a 400, since deleting a document
 * the caller has not read is never what they meant; a stale one is a 409 with
 * nothing written.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const resolved = resolvePolicyRouteTarget(event);
  if ('response' in resolved) return resolved.response;
  const { bucketName, region } = resolved.target;

  const etag = event.queryStringParameters?.etag;
  if (!etag) return badRequestResponse('The etag of the policy being removed is required');

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
    await orchestrator.iam.deleteBucketPolicy(tenantId, bucketName, { ifMatch: etag });
    await audit.complete({ outcome: 'succeeded' });
    return new ResponseBuilder().status(204).build();
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
