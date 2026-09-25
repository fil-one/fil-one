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
  roleHasPermission,
} from '@filone/shared';
import type { BucketPolicy, ErrorResponse, PutBucketPolicyResponse } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  bucketPolicyErrorResponse,
  namedPrincipalCount,
  resolveIamWriteTarget,
  resolvePolicyRouteTarget,
} from '../lib/bucket-policy-route.ts';
import type { IamMethods } from '../lib/iam-orchestrator.ts';
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
 * The body carries the ETag the last read returned; without one the write
 * creates the bucket's first policy and is refused if one exists. Either way a
 * stale edit loses with nothing written, and the console re-reads.
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

  const parsed = parseJsonBody(event.body, PutBucketPolicyRequestSchema);
  if ('error' in parsed) return parsed.error;
  const { policy, etag } = parsed.data;

  const { orgId, userId, membership } = getUserInfo(event);
  const mayGrantRetention = roleHasPermission(membership?.role ?? NO_ROLE, 'privileged.grant');
  const refusedFirst = refuseFirstPolicyRetentionGrants({ policy, etag, mayGrantRetention });
  if (refusedFirst) return refusedFirst;

  const target = await resolveIamWriteTarget(orgId, region);
  if ('response' in target) return target.response;
  const { orchestrator, tenantId } = target;

  if (etag && !mayGrantRetention) {
    const refused = await refuseNewRetentionGrants(orchestrator.iam, tenantId, bucketName, policy);
    if (refused) return refused;
  }

  // The intent names the kind of write the caller asked for, so the two halves
  // agree whatever the vendor answers.
  const audit = await twoPhaseAudit({
    type: etag ? 'bucket_policy.updated' : 'bucket_policy.created',
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
      etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
    );
    await audit.complete({
      outcome: 'succeeded',
      details: { statements: policy.statement.length, principals: namedPrincipalCount(policy) },
    });
    return new ResponseBuilder()
      .status(written.created ? 201 : 200)
      .body<PutBucketPolicyResponse>({ etag: written.etag, created: written.created })
      .build();
  } catch (err) {
    const response = bucketPolicyErrorResponse(err);
    if (!response) throw err;
    await audit.complete({ outcome: 'failed' });
    return response;
  }
}

/**
 * The cap on a first policy, which is compared against nothing: it needs no
 * vendor read and answers ahead of the region, since the refusal depends on
 * neither. A replacement, or a caller who may grant, passes through.
 */
function refuseFirstPolicyRetentionGrants({
  policy,
  etag,
  mayGrantRetention,
}: {
  policy: BucketPolicy;
  etag: string | undefined;
  mayGrantRetention: boolean;
}): APIGatewayProxyStructuredResultV2 | undefined {
  if (etag || mayGrantRetention) return undefined;
  return addsRetentionGrants(null, policy) ? retentionGrantForbiddenResponse() : undefined;
}

/**
 * For a caller without `privileged.grant`, the cap on a replacement: the
 * stored document is read, and the write is refused if the new one grants a
 * retention write the stored one did not, or names one outright that the stored
 * one did not name. A read that fails answers as the write would have.
 */
async function refuseNewRetentionGrants(
  iam: IamMethods,
  tenantId: string,
  bucketName: string,
  next: BucketPolicy,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  let current: BucketPolicy | null;
  try {
    current = (await iam.getBucketPolicy(tenantId, bucketName))?.policy ?? null;
  } catch (err) {
    const response = bucketPolicyErrorResponse(err);
    if (!response) throw err;
    return response;
  }
  return addsRetentionGrants(current, next) || addsNamedRetentionGrants(current, next)
    ? retentionGrantForbiddenResponse()
    : undefined;
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
    const action = grant.slice(grant.indexOf('|') + 1);
    return !before.has(grant) && !before.has(`${POLICY_WILDCARD_PRINCIPAL}|${action}`);
  });
}

/** Each principal an allow names a retention write for outright, keyed with the action. */
function namedRetentionGrants(policy: BucketPolicy | null): Set<string> {
  const grants = new Set<string>();
  for (const statement of policy?.statement ?? []) {
    if (statement.effect !== 'allow') continue;
    const principals =
      statement.principal === POLICY_WILDCARD_PRINCIPAL
        ? [POLICY_WILDCARD_PRINCIPAL]
        : statement.principal;
    for (const action of statement.action) {
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
