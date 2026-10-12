import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  NO_ROLE,
  POLICY_WILDCARD_PRINCIPAL,
  PutBucketPolicyRequestSchema,
  RETENTION_WRITE_ACTIONS,
  hasNewRetentionGrants,
  roleHasPermission,
} from '@filone/shared';
import type { BucketPolicy, ErrorResponse, PolicyAction } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  countNamedPrincipals,
  parsePreconditionHeaders,
  resolveIamWriteTarget,
  resolvePolicyRouteTarget,
  toPolicyErrorResponse,
} from '../lib/bucket-policy-route.ts';
import type {
  BucketPolicyOrchestrator,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../lib/iam-orchestrator.ts';
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
 * the stored policy. The Owners' roster statement carries `s3:*`, so an Admin
 * who edits another statement is not granting it again. A retention write
 * listed by name is also compared by name with the stored policy. An Admin may
 * keep or narrow one that an Owner wrote, but may not add one, even for an
 * Owner who already holds it through `s3:*`. The storage system enforces the
 * statement without knowing that these actions are privileged, so this route
 * has to apply the rule.
 *
 * As on S3, `If-Match` replaces only the version the caller read and
 * `If-None-Match: *` creates only the first; either way a stale edit is a 412
 * with nothing written, and the console re-reads. Without either the write is
 * unconditional. It answers 204 with the new version in the `ETag` header.
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

  const preconditionResult = parsePreconditionHeaders(event);
  if ('response' in preconditionResult) return preconditionResult.response;
  let { precondition } = preconditionResult;
  const isFirstPolicyWrite = precondition !== undefined && 'ifNoneMatch' in precondition;

  const parsed = parseJsonBody(event.body, PutBucketPolicyRequestSchema);
  if ('error' in parsed) return parsed.error;
  const { policy } = parsed.data;

  const { orgId, userId, membership } = getUserInfo(event);
  const canGrantRetention = roleHasPermission(membership?.role ?? NO_ROLE, 'privileged.grant');
  const firstPolicyRefusal = getFirstPolicyRetentionRefusal({
    policy,
    isFirstPolicyWrite,
    canGrantRetention,
  });
  if (firstPolicyRefusal) return firstPolicyRefusal;

  const writeTarget = await resolveIamWriteTarget(orgId, region);
  if ('response' in writeTarget) return writeTarget.response;
  const { orchestrator, tenantId } = writeTarget;

  if (!isFirstPolicyWrite && !canGrantRetention) {
    const retentionCheck = await checkNewRetentionGrants(
      orchestrator,
      tenantId,
      bucketName,
      policy,
    );
    if ('response' in retentionCheck) return retentionCheck.response;
    precondition ??= retentionCheck.pinnedPrecondition;
  }

  // The intent names the kind of write the caller asked for, so the two halves
  // agree whatever the vendor answers.
  const audit = await twoPhaseAudit({
    // ponytail: an unconditional write that creates is recorded as an update;
    // tell them apart by reading first if the log ever needs it.
    type: isFirstPolicyWrite ? 'bucket_policy.created' : 'bucket_policy.updated',
    mode: 'fail-closed',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'policy_edited' },
  });

  try {
    const written = await orchestrator.putBucketPolicy(tenantId, bucketName, policy, precondition);
    await audit.complete({
      outcome: 'succeeded',
      details: { statements: policy.Statement.length, principals: countNamedPrincipals(policy) },
    });
    return new ResponseBuilder().status(204).header('ETag', written.etag).emptyBody().build();
  } catch (err) {
    const response = toPolicyErrorResponse(err);
    if (!response) throw err;
    await audit.complete({ outcome: 'failed' });
    return response;
  }
}

/**
 * The retention cap on a first policy (`If-None-Match: *`). There is no stored
 * policy to compare with, so it needs no vendor read and runs before the
 * region is checked. Returns the 403, or undefined when the write is not a
 * first policy or the caller may grant.
 */
function getFirstPolicyRetentionRefusal({
  policy,
  isFirstPolicyWrite,
  canGrantRetention,
}: {
  policy: BucketPolicy;
  isFirstPolicyWrite: boolean;
  canGrantRetention: boolean;
}): APIGatewayProxyStructuredResultV2 | undefined {
  if (!isFirstPolicyWrite || canGrantRetention) return undefined;
  return hasNewRetentionGrants(null, policy) ? retentionGrantForbiddenResponse() : undefined;
}

/**
 * The retention cap on a replacement, for a caller without `privileged.grant`.
 * It reads the stored policy and refuses the write if the new one grants a
 * retention write the stored one did not, or names one outright that the
 * stored one did not name. If the read fails, the caller gets the same error
 * response the write would have produced.
 *
 * Otherwise it returns a precondition pinned to the version it checked. An
 * unconditional write takes it, so an Owner's write in between cannot slip a
 * grant past the cap.
 */
async function checkNewRetentionGrants(
  policies: BucketPolicyOrchestrator,
  tenantId: string,
  bucketName: string,
  next: BucketPolicy,
): Promise<
  { pinnedPrecondition: PolicyPrecondition } | { response: APIGatewayProxyStructuredResultV2 }
> {
  let stored: StoredBucketPolicy | null;
  try {
    stored = await policies.getBucketPolicy(tenantId, bucketName);
  } catch (err) {
    const response = toPolicyErrorResponse(err);
    if (!response) throw err;
    return { response };
  }
  const current = stored?.policy ?? null;
  return hasNewRetentionGrants(current, next) || hasNewNamedRetentionGrants(current, next)
    ? { response: retentionGrantForbiddenResponse() }
    : { pinnedPrecondition: stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' } };
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
        : statement.Principal;
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
