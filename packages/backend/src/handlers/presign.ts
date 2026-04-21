import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  getS3Endpoint,
  S3_REGION,
  PresignRequestSchema,
  SubscriptionStatus,
} from '@filone/shared';
import type {
  ErrorResponse,
  PresignOp,
  PresignResponse,
  PresignResponseItem,
} from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  getAuroraS3Credentials,
  getPresignedPutObjectUrl,
  getPresignedGetObjectUrl,
  getPresignedListObjectsUrl,
  getPresignedHeadObjectUrl,
  getPresignedGetObjectRetentionUrl,
  getPresignedDeleteObjectUrl,
} from '../lib/aurora-s3-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

const PRESIGN_EXPIRY_SECONDS = 300;

const WRITE_OPS = new Set<string>(['putObject', 'deleteObject']);

async function presignOp(
  op: PresignOp,
  endpointUrl: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
): Promise<PresignResponseItem> {
  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY_SECONDS * 1000).toISOString();

  switch (op.op) {
    case 'listObjects': {
      const url = await getPresignedListObjectsUrl({
        endpointUrl,
        credentials,
        bucket: op.bucket,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        prefix: op.prefix,
        delimiter: op.delimiter,
        maxKeys: op.maxKeys,
        continuationToken: op.continuationToken,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'headObject': {
      const url = await getPresignedHeadObjectUrl({
        endpointUrl,
        credentials,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        includeFilMeta: op.includeFilMeta,
      });
      return { url, method: 'HEAD', expiresAt };
    }

    case 'getObjectRetention': {
      const url = await getPresignedGetObjectRetentionUrl({
        endpointUrl,
        credentials,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'getObject': {
      const url = await getPresignedGetObjectUrl({
        endpointUrl,
        credentials,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      });
      return { url, method: 'GET', expiresAt };
    }

    case 'putObject': {
      const metadata: Record<string, string> = { filename: op.fileName };
      if (op.description) {
        metadata.description = op.description;
      }
      if (op.tags && op.tags.length > 0) {
        metadata.tags = JSON.stringify(op.tags);
      }

      const url = await getPresignedPutObjectUrl({
        endpointUrl,
        credentials,
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
        endpointUrl,
        credentials,
        bucket: op.bucket,
        key: op.key,
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      });
      return { url, method: 'DELETE', expiresAt };
    }
  }
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
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

  // The subscription guard middleware uses Read access level so that listing
  // and viewing objects still works during a grace period. The middleware stores
  // the resolved subscription status on the event, so we can check it here
  // without a second DynamoDB query. If the batch contains write ops
  // (putObject, deleteObject), block during grace period.
  if (ops.some((op) => WRITE_OPS.has(op.op))) {
    const status = event.requestContext.subscriptionStatus;
    if (status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue) {
      return new ResponseBuilder()
        .status(403)
        .body<ErrorResponse>({
          message:
            'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
          code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
        })
        .build();
    }
  }

  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    console.error('Aurora tenant setup is not complete', { orgId, auroraTenantId, setupStatus });
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  const stage = process.env.FILONE_STAGE!;
  const endpointUrl = getS3Endpoint(S3_REGION, stage);

  const credentials = await getAuroraS3Credentials(stage, auroraTenantId);

  const items = await Promise.all(ops.map((op) => presignOp(op, endpointUrl, credentials)));

  return new ResponseBuilder()
    .status(200)
    .body<PresignResponse>({ items, endpoint: endpointUrl })
    .build();
}

// Use Read access level in middleware. Write access is checked in the handler
// before generating presigned URLs for write operations (putObject, deleteObject).
export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
