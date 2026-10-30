import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  NO_ROLE,
  POLICY_WILDCARD_PRINCIPAL,
  PutBucketPolicyRequestSchema,
  RETENTION_WRITE_ACTIONS,
  getPrincipalIds,
  hasNewRetentionGrants,
  roleHasPermission,
} from '@filone/shared';
import type { BucketPolicy, ErrorResponse, PolicyAction } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  countNamedPrincipals,
  resolveIamWriteTarget,
  syncNamedMembers,
  resolvePolicyRouteTarget,
  toPolicyErrorResponse,
} from '../lib/bucket-policy-route.ts';
import type { BucketPolicyOrchestrator } from '../lib/bucket-policy-orchestrator.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * PUT /api/buckets/{name}/policy?region= — create or replace the bucket's
 * policy.
 *
 * The route needs `buckets.policy_manage`. A statement that newly grants one
 * of the `RETENTION_WRITE_ACTIONS`, or `s3:*` which covers them, also needs
 * `privileged.grant`, which only an Owner holds. "Newly" is measured against
 * the stored policy. A statement an Owner wrote may carry `s3:*`, so an Admin
 * who edits another statement is not granting it again. A retention write
 * listed by name is also compared by name with the stored policy. An Admin may
 * keep or narrow one that an Owner wrote, but may not add one, even for an
 * Owner who already holds it through `s3:*`. The storage system enforces the
 * statement without knowing that these actions are privileged, so this route
 * has to apply the rule.
 *
 * As on S3, the write is unconditional and the last write wins. It answers
 * 204.
 *
 * Two-phase audit around the vendor call, as for a key: the document lives at
 * the storage system and nothing local records it, so a crash between the two
 * halves leaves a visible dangling intent rather than an unrecorded change.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const routeTarget = resolvePolicyRouteTarget(event);
  if ('response' in routeTarget) return routeTarget.response;
  const { bucketName, region } = routeTarget.target;

  const parsed = parseJsonBody(event.body, PutBucketPolicyRequestSchema);
  if ('error' in parsed) return parsed.error;
  const { policy } = parsed.data;

  const { orgId, userId, membership } = getUserInfo(event);
  const canGrantRetention = roleHasPermission(membership?.role ?? NO_ROLE, 'privileged.grant');

  const writeTarget = await resolveIamWriteTarget(orgId, region);
  if ('response' in writeTarget) return writeTarget.response;
  const { orchestrator, tenantId } = writeTarget;

  if (!canGrantRetention) {
    const refusal = await checkNewRetentionGrants(orchestrator, tenantId, bucketName, policy);
    if (refusal) return refusal;
  }

  await syncNamedMembers(orchestrator, tenantId, orgId, policy);

  const audit = await twoPhaseAudit({
    // ponytail: a write that creates the first policy is recorded as an update;
    // tell them apart by reading first if the log ever needs it.
    type: 'bucket_policy.updated',
    mode: 'fail-closed',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'policy_edited' },
  });

  try {
    await orchestrator.putBucketPolicy(tenantId, bucketName, policy);
    await audit.complete({
      outcome: 'succeeded',
      details: { statements: policy.Statement.length, principals: countNamedPrincipals(policy) },
    });
    return new ResponseBuilder().status(204).emptyBody().build();
  } catch (err) {
    const response = toPolicyErrorResponse(err);
    if (!response) throw err;
    await audit.complete({ outcome: 'failed' });
    return response;
  }
}

/**
 * The retention cap for a caller without `privileged.grant`. It reads the
 * stored policy, or none, and refuses the write if the new one grants a
 * retention write the stored one did not, or names one outright that the
 * stored one did not name. If the read fails, the caller gets the same error
 * response the write would have produced. Returns undefined when the write may
 * go ahead.
 *
 * The write that follows is unconditional. An Owner's write landing between
 * this read and that write is overwritten, a retention grant it removed
 * included: the last write wins, for this check as for the rest of the
 * document (fil-one/RFC rfcs/2026-10-bucket-policy-writes-without-locks.md).
 */
async function checkNewRetentionGrants(
  policies: BucketPolicyOrchestrator,
  tenantId: string,
  bucketName: string,
  next: BucketPolicy,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  let current: BucketPolicy | null;
  try {
    current = await policies.getBucketPolicy(tenantId, bucketName);
  } catch (err) {
    const response = toPolicyErrorResponse(err);
    if (!response) throw err;
    return response;
  }
  return hasNewRetentionGrants(current, next) || hasNewNamedRetentionGrants(current, next)
    ? retentionGrantForbiddenResponse()
    : undefined;
}

/**
 * Whether `next` names a retention write for a principal that `current` does
 * not name it for. Only actions listed by name count, not `s3:*`, so this
 * holds even when the principal already has the write through `s3:*`. An
 * Allow to `*` already names the action for every principal.
 */
function hasNewNamedRetentionGrants(current: BucketPolicy | null, next: BucketPolicy): boolean {
  const before = getNamedRetentionGrants(current);
  const everyone = before.get(POLICY_WILDCARD_PRINCIPAL);
  for (const [principal, actions] of getNamedRetentionGrants(next)) {
    const held = before.get(principal);
    for (const action of actions) {
      if (!held?.has(action) && !everyone?.has(action)) return true;
    }
  }
  return false;
}

/** The retention writes each principal is allowed by name, keyed by principal id or `*`. */
function getNamedRetentionGrants(policy: BucketPolicy | null): Map<string, Set<PolicyAction>> {
  const grants = new Map<string, Set<PolicyAction>>();
  for (const statement of policy?.Statement ?? []) {
    if (statement.Effect !== 'Allow') continue;
    const actions = RETENTION_WRITE_ACTIONS.filter((action) => statement.Action.includes(action));
    if (actions.length === 0) continue;
    const principals =
      statement.Principal === POLICY_WILDCARD_PRINCIPAL
        ? [POLICY_WILDCARD_PRINCIPAL]
        : getPrincipalIds(statement.Principal);
    for (const principal of principals) {
      const held = grants.get(principal) ?? new Set<PolicyAction>();
      for (const action of actions) held.add(action);
      grants.set(principal, held);
    }
  }
  return grants;
}

function retentionGrantForbiddenResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Only an Owner can grant setting retention or legal holds.',
      code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.policy_manage'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
