import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { CreateBucketResponse, ErrorResponse, S3Region } from '@filone/shared';
import { CreateBucketSchema, getAvailableRegions } from '@filone/shared';
import { createAuroraBucket, BucketAlreadyExistsError } from '../lib/aurora-portal.js';
import { getOrgAuroraTenant } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
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

  const { name, region, versioning, lock, retention } = parsed.data;

  const allowedRegions = getAvailableRegions(process.env.FILONE_STAGE!);
  if (region !== undefined && !allowedRegions.includes(region as S3Region)) {
    const message = `Unsupported region. Supported: ${allowedRegions.join(', ')}`;
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
  }

  const { orgId } = getUserInfo(event);
  const tenant = await getOrgAuroraTenant(orgId);
  if (!tenant.ok) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({ message: tenant.message })
      .build();
  }
  const auroraTenantId = tenant.auroraTenantId;

  try {
    await createAuroraBucket({
      tenantId: auroraTenantId,
      bucketName: name,
      versioning,
      lock,
      retention,
    });
  } catch (err) {
    if (err instanceof BucketAlreadyExistsError) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: `Bucket "${name}" already exists` })
        .build();
    }
    throw err;
  }

  const now = new Date().toISOString();

  return new ResponseBuilder()
    .status(201)
    .body<CreateBucketResponse>({
      bucket: {
        name,
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
