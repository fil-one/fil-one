import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  PresignRequestSchema,
  SubscriptionStatus,
  isSupportedRegion,
} from '@filone/shared';
import type {
  ErrorResponse,
  Permission,
  PresignOp,
  PresignResponse,
  PresignResponseItem,
} from '@filone/shared';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { S3ClientContext } from '../lib/s3-client.js';
import {
  getPresignedDeleteObjectUrl,
  getPresignedGetObjectRetentionUrl,
  getPresignedGetObjectUrl,
  getPresignedHeadObjectUrl,
  getPresignedListObjectVersionsUrl,
  getPresignedListObjectsUrl,
  getPresignedPutObjectUrl,
} from '../lib/s3-presigner.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireOrgMembershipMiddleware, requirePermission } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const PRESIGN_EXPIRY_SECONDS = 300;
const MAX_GET_OBJECT_EXPIRY_SECONDS = 604800;

const WRITE_OPS = new Set<string>(['putObject', 'deleteObject']);

/**
 * The permission each presign operation needs. One route serves all seven, so
 * the check runs here rather than in the chain — the route manifest marks it
 * `in-handler` and lists this same mapping.
 *
 * `getObjectRetention` reads retention state rather than changing it, which is
 * the auditor's read and an ordinary `objects.read`. A presign that *mutates*
 * retention or legal hold is a different matter and none exists: it would be
 * redeemed at the vendor, where its use cannot be logged, so adding one behind
 * a general object permission would hand M2 a capability to claw back.
 */
const OP_PERMISSIONS: Record<PresignOp['op'], Permission> = {
  getObject: 'objects.read',
  headObject: 'objects.read',
  listObjects: 'objects.read',
  listObjectVersions: 'objects.read',
  getObjectRetention: 'objects.read',
  putObject: 'objects.write',
  deleteObject: 'objects.delete',
};

/**
 * Refuse the whole batch if any operation in it is refused, naming the one that
 * failed. Whole rather than partial because the caller asked for a set of URLs
 * and a response holding some of them would be indistinguishable from a set
 * they are entitled to.
 */
function checkPresignPermissions(
  event: AuthenticatedEvent,
  ops: PresignOp[],
): APIGatewayProxyStructuredResultV2 | undefined {
  for (const op of ops) {
    const denied = requirePermission(
      event,
      OP_PERMISSIONS[op.op],
      `Your role in this organization does not permit ${op.op}.`,
    );
    if (denied) return denied;
  }
  return undefined;
}

async function presignGetObject(
  op: Extract<PresignOp, { op: 'getObject' }>,
  ctx: S3ClientContext,
): Promise<PresignResponseItem> {
  const expiresIn = Math.min(op.expiresIn ?? PRESIGN_EXPIRY_SECONDS, MAX_GET_OBJECT_EXPIRY_SECONDS);
  const url = await getPresignedGetObjectUrl({
    ctx,
    bucket: op.bucket,
    key: op.key,
    expiresIn,
    versionId: op.versionId,
  });
  return {
    url,
    method: 'GET',
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function presignOp(op: PresignOp, ctx: S3ClientContext): Promise<PresignResponseItem> {
  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY_SECONDS * 1000).toISOString();

  switch (op.op) {
    case 'listObjects': {
      const url = await getPresignedListObjectsUrl({
        ctx,
        bucket: op.bucket,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        prefix: op.prefix,
        delimiter: op.delimiter,
        maxKeys: op.maxKeys,
        continuationToken: op.continuationToken,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'listObjectVersions': {
      const url = await getPresignedListObjectVersionsUrl({
        ctx,
        bucket: op.bucket,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        prefix: op.prefix,
        delimiter: op.delimiter,
        maxKeys: op.maxKeys,
        keyMarker: op.keyMarker,
        versionIdMarker: op.versionIdMarker,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'headObject': {
      const url = await getPresignedHeadObjectUrl({
        ctx,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        versionId: op.versionId,
      });
      return { url, method: 'HEAD', expiresAt };
    }

    case 'getObjectRetention': {
      const url = await getPresignedGetObjectRetentionUrl({
        ctx,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        versionId: op.versionId,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'getObject':
      return presignGetObject(op, ctx);

    case 'putObject': {
      const metadata: Record<string, string> = { filename: op.fileName };
      if (op.description) {
        metadata.description = op.description;
      }
      if (op.tags && op.tags.length > 0) {
        metadata.tags = JSON.stringify(op.tags);
      }

      const url = await getPresignedPutObjectUrl({
        ctx,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        contentType: op.contentType,
        metadata,
      });
      return { url, method: 'PUT', expiresAt };
    }

    case 'deleteObject': {
      const url = await getPresignedDeleteObjectUrl({
        ctx,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        versionId: op.versionId,
      });
      return { url, method: 'DELETE', expiresAt };
    }
  }
}

/**
 * What the caller's plan permits, as distinct from what their role permits.
 *
 * Trial accounts (and users with no billing record yet) cannot mint shareable
 * links — `getObject` with a custom `expiresIn`; everything else stays
 * available so a trial user can browse and interact with bucket contents
 * normally. During a grace period the batch may read but not write: the
 * subscription guard runs at Read level so viewing keeps working, and it leaves
 * the resolved status on the event, so this costs no second query.
 */
function checkSubscriptionState(
  event: AuthenticatedEvent,
  ops: PresignOp[],
): APIGatewayProxyStructuredResultV2 | undefined {
  const status = event.requestContext.subscriptionStatus;

  const isTrial = !status || status === SubscriptionStatus.Trialing;
  const hasShareableUrl = ops.some((op) => op.op === 'getObject' && op.expiresIn !== undefined);
  if (isTrial && hasShareableUrl) {
    return new ResponseBuilder()
      .status(402)
      .body<ErrorResponse>({
        message:
          'Generating shareable links is not available on trial accounts. Please upgrade to a paid plan.',
        code: ApiErrorCode.TRIAL_PRESIGN_BLOCKED,
      })
      .build();
  }

  const hasWriteOps = ops.some((op) => WRITE_OPS.has(op.op));
  const isGraceOrPastDue =
    status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue;
  if (hasWriteOps && isGraceOrPastDue) {
    return new ResponseBuilder()
      .status(403)
      .body<ErrorResponse>({
        message:
          'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
        code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
      })
      .build();
  }

  return undefined;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const region = event.queryStringParameters?.region;
  if (!region) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'region query parameter is required' })
      .build();
  }
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '[]');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = PresignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const ops = parsed.data;
  const { orgId } = getUserInfo(event);

  // Authorization first: what the caller's role permits does not depend on
  // their billing state, and a member denied an operation should hear that
  // rather than be told to upgrade.
  const denied = checkPresignPermissions(event, ops);
  if (denied) return denied;

  const blocked = checkSubscriptionState(event, ops);
  if (blocked) return blocked;

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  const ctx = await orchestrator.getS3ClientContext(tenantId);

  const items = await Promise.all(ops.map((op) => presignOp(op, ctx)));

  return new ResponseBuilder()
    .status(200)
    .body<PresignResponse>({ items, endpoint: ctx.endpointUrl })
    .build();
}

// Use Read access level in middleware. Write access is checked in the handler
// before generating presigned URLs for write operations (putObject, deleteObject).
export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // The permission depends on the requested operations, so the handler decides
  // it; membership does not, so it is settled here — before the billing read,
  // and inside the metric that says whether the conversion missed a cohort.
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(rateLimitMiddleware())
  .use(errorHandlerMiddleware());
