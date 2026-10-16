import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { CreateBucketResponse, ErrorResponse, S3Region } from '@filone/shared';
import {
  CreateBucketSchema,
  getCreatorBucketPolicy,
  isSupportedRegion,
  supportsIamMethods,
} from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import type { AuditCorrelation } from '../lib/audit.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import {
  BucketAlreadyExistsError,
  BucketConfigurationError,
  PolicyValidationError,
} from '../lib/errors.ts';
import { isOrgDeleting } from '../lib/org-profile.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
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

  const { orgId, userId } = getUserInfo(event);

  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  // Before ensureTenantReady: the bucket is created upstream, so a fence
  // checked only at the DynamoDB write would leave it behind.
  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return tenantNotReadyResponse();

  // A new bucket starts with one statement naming its creator on a region that
  // serves policies, and with none on a `service-keys` region.
  const policy = supportsIamMethods(region) ? getCreatorBucketPolicy(userId) : undefined;
  const policyAudit = policy
    ? await auditDefaultBucketPolicy({ event, orgId, userId, region, bucketName })
    : undefined;

  const completionDetails = { statements: policy?.Statement.length };

  try {
    await orchestrator.createBucket(tenantId, {
      bucketName,
      versioning,
      lock,
      retention,
      ...(policy ? { policy } : {}),
    });
  } catch (err) {
    // The bucket was created but couldn't be fully configured. Surface the
    // actionable message so the caller can finish setup via the S3 API instead
    // of getting the generic 500 from errorHandlerMiddleware. The orchestrator
    // writes the policy before the configuration calls, so that write succeeded.
    if (err instanceof BucketConfigurationError) {
      await policyAudit?.complete({ outcome: 'succeeded', details: completionDetails });
      return new ResponseBuilder()
        .status(500)
        .body<ErrorResponse>({ message: err.message })
        .build();
    }
    await policyAudit?.complete({ outcome: 'failed' });
    const refusal = toCreateRefusalResponse(err, bucketName);
    if (!refusal) throw err;
    return refusal;
  }
  await policyAudit?.complete({ outcome: 'succeeded', details: completionDetails });

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

/**
 * The default policy is written at the storage system with the bucket, so it is
 * recorded like every other policy write: an intent before the call and a
 * completion after it. Best-effort rather than fail-closed, because the
 * document is the roster the console derives rather than a grant somebody
 * authored, and an audit outage must not stop buckets being created.
 */
function auditDefaultBucketPolicy({
  event,
  orgId,
  userId,
  region,
  bucketName,
}: {
  event: AuthenticatedEvent;
  orgId: string;
  userId: string;
  region: S3Region;
  bucketName: string;
}): Promise<AuditCorrelation<'bucket_policy.created'>> {
  return twoPhaseAudit({
    type: 'bucket_policy.created',
    mode: 'best-effort',
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'bucket_created' },
  });
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.create'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());

/**
 * The console's answer to a refusal the create can raise, or undefined for an
 * error that is not one, which the caller rethrows into the generic 500.
 */
function toCreateRefusalResponse(
  err: unknown,
  bucketName: string,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (err instanceof BucketAlreadyExistsError) {
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: `Bucket "${bucketName}" already exists` })
      .build();
  }
  // The storage system refused the policy; the bucket exists without one.
  // Other policy write errors go to errorHandlerMiddleware.
  if (err instanceof PolicyValidationError) {
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  return undefined;
}
