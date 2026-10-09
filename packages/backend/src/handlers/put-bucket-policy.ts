import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  NO_ROLE,
  POLICY_WILDCARD_PRINCIPAL,
  PutBucketPolicyRequestSchema,
  RETENTION_WRITE_ACTIONS,
  addsRetentionGrants,
  isRosterSid,
  roleHasPermission,
} from '@filone/shared';
import type { BucketPolicy, ErrorResponse, PutBucketPolicyRequest } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  bucketPolicyErrorResponse,
  namedPrincipalCount,
  readPolicyPrecondition,
  resolveIamWriteTarget,
  resolvePolicyRouteTarget,
} from '../lib/bucket-policy-route.ts';
import type {
  IamMethods,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../lib/iam-orchestrator.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import type { ParsedBody } from '../lib/parse-json-body.ts';
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
 * `buckets.policy_manage` is what reaching the route costs. The cap on top of
 * it depends on the body: a statement that newly grants `s3:PutObjectRetention`
 * or `s3:PutObjectLegalHold`, or `s3:*` which stands for both, needs
 * `privileged.grant`, which only an Owner holds. Newly, against the stored
 * document: the roster statement the console writes for Owners carries `s3:*`,
 * so an Admin editing an unrelated statement is not granting it again. A
 * retention write named outright is held to the stored document by name, so an
 * Admin may keep or narrow one an Owner wrote but not add one, even for an
 * Owner who holds it through `s3:*`. The storage system enforces the statement
 * without knowing either action was privileged, so the rule has to hold here.
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
  const resolved = resolvePolicyRouteTarget(event);
  if ('response' in resolved) return resolved.response;
  const { bucketName, region } = resolved.target;

  const read = readPolicyPrecondition(event);
  if ('response' in read) return read.response;
  let { precondition } = read;
  const creating = precondition !== undefined && 'ifNoneMatch' in precondition;

  const parsed = parsePolicyBody(event.body);
  if ('error' in parsed) return parsed.error;
  const { policy } = parsed.data;

  const { orgId, userId, membership } = getUserInfo(event);
  const mayGrantRetention = roleHasPermission(membership?.role ?? NO_ROLE, 'privileged.grant');
  const refusedFirst = refuseFirstPolicyRetentionGrants({ policy, creating, mayGrantRetention });
  if (refusedFirst) return refusedFirst;

  const target = await resolveIamWriteTarget(orgId, region);
  if ('response' in target) return target.response;
  const { orchestrator, tenantId } = target;

  if (!creating && !mayGrantRetention) {
    const checked = await refuseNewRetentionGrants(orchestrator.iam, tenantId, bucketName, policy);
    if ('response' in checked) return checked.response;
    precondition ??= checked.pinned;
  }

  // The intent names the kind of write the caller asked for, so the two halves
  // agree whatever the vendor answers.
  const audit = await twoPhaseAudit({
    // ponytail: an unconditional write that creates is recorded as an update;
    // tell them apart by reading first if the log ever needs it.
    type: creating ? 'bucket_policy.created' : 'bucket_policy.updated',
    mode: 'fail-closed',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'policy_edit' },
  });

  try {
    const written = await orchestrator.iam.putBucketPolicy(
      tenantId,
      bucketName,
      policy,
      precondition,
    );
    await audit.complete({
      outcome: 'succeeded',
      details: { statements: policy.Statement.length, principals: namedPrincipalCount(policy) },
    });
    return { statusCode: 204, headers: { ETag: written.etag }, body: '' };
  } catch (err) {
    const response = bucketPolicyErrorResponse(err);
    if (!response) throw err;
    await audit.complete({ outcome: 'failed' });
    return response;
  }
}

/**
 * The body, parsed, with one rule the schema leaves to the route: the roster
 * labels name the console's own statements, which the role-change fan-out
 * finds and rewrites by label. Each may appear once and only on an allow, so
 * the fan-out never drops a statement a user wrote. Its principals and actions
 * stay editable.
 */
function parsePolicyBody(raw: string | undefined): ParsedBody<PutBucketPolicyRequest> {
  const parsed = parseJsonBody(raw, PutBucketPolicyRequestSchema);
  if ('error' in parsed) return parsed;
  const seen = new Set<string>();
  for (const { Sid: sid, Effect: effect } of parsed.data.policy.Statement) {
    if (!sid || !isRosterSid(sid)) continue;
    if (effect !== 'Allow' || seen.has(sid)) {
      const error = new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({
          message: `The label "${sid}" is reserved for the console\u2019s own allow statement.`,
        })
        .build();
      return { error };
    }
    seen.add(sid);
  }
  return parsed;
}

/**
 * The cap on a first policy (`If-None-Match: *`), which is compared against
 * nothing: it needs no vendor read and answers ahead of the region, since the
 * refusal depends on neither. Any other write, or a caller who may grant,
 * passes through.
 */
function refuseFirstPolicyRetentionGrants({
  policy,
  creating,
  mayGrantRetention,
}: {
  policy: BucketPolicy;
  creating: boolean;
  mayGrantRetention: boolean;
}): APIGatewayProxyStructuredResultV2 | undefined {
  if (!creating || mayGrantRetention) return undefined;
  return addsRetentionGrants(null, policy) ? retentionGrantForbiddenResponse() : undefined;
}

/**
 * For a caller without `privileged.grant`, the cap on a replacement: the
 * stored document is read, and the write is refused if the new one grants a
 * retention write the stored one did not, or names one outright that the stored
 * one did not name. A read that fails answers as the write would have.
 *
 * Otherwise it answers the precondition pinning the version it checked, which
 * an unconditional write takes, so an Owner's write in between cannot slip a
 * grant past the cap.
 */
async function refuseNewRetentionGrants(
  iam: IamMethods,
  tenantId: string,
  bucketName: string,
  next: BucketPolicy,
): Promise<{ pinned: PolicyPrecondition } | { response: APIGatewayProxyStructuredResultV2 }> {
  let stored: StoredBucketPolicy | null;
  try {
    stored = await iam.getBucketPolicy(tenantId, bucketName);
  } catch (err) {
    const response = bucketPolicyErrorResponse(err);
    if (!response) throw err;
    return { response };
  }
  const current = stored?.policy ?? null;
  return addsRetentionGrants(current, next) || addsNamedRetentionGrants(current, next)
    ? { response: retentionGrantForbiddenResponse() }
    : { pinned: stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' } };
}

/**
 * Whether `next` names a retention or legal-hold write for a principal that
 * `current` does not name it for. Only actions spelled out count, not `s3:*`,
 * so this holds even when the principal already has the write through `s3:*`.
 * A name for everyone covers every principal.
 */
function addsNamedRetentionGrants(current: BucketPolicy | null, next: BucketPolicy): boolean {
  const before = namedRetentionGrants(current);
  return [...namedRetentionGrants(next)].some((grant) => {
    // Split at the last bar: principal ids may hold one (`auth0|…`), actions never do.
    const action = grant.slice(grant.lastIndexOf('|') + 1);
    return !before.has(grant) && !before.has(`${POLICY_WILDCARD_PRINCIPAL}|${action}`);
  });
}

/** Each principal an allow names a retention write for outright, keyed with the action. */
function namedRetentionGrants(policy: BucketPolicy | null): Set<string> {
  const grants = new Set<string>();
  for (const statement of policy?.Statement ?? []) {
    if (statement.Effect !== 'Allow') continue;
    const principals =
      statement.Principal === POLICY_WILDCARD_PRINCIPAL
        ? [POLICY_WILDCARD_PRINCIPAL]
        : statement.Principal;
    for (const action of statement.Action) {
      if (!(RETENTION_WRITE_ACTIONS as readonly string[]).includes(action)) continue;
      for (const principal of principals) grants.add(`${principal}|${action}`);
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
