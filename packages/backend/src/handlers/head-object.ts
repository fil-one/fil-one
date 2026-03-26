import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse, ObjectMetadataResponse } from '@filone/shared';
import { HeadObjectQuerySchema } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getAuroraS3Credentials, headObject, getObjectRetention } from '../lib/aurora-s3-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { isNoSuchBucketError, isNotFoundError } from '../lib/s3-errors.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  const queryParsed = HeadObjectQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!queryParsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: queryParsed.error.issues[0].message })
      .build();
  }

  const { key: objectKey } = queryParsed.data;

  const { orgId } = getUserInfo(event);

  // Look up org profile to get auroraTenantId
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
  const gatewayUrl = process.env.AURORA_S3_GATEWAY_URL!;

  const credentials = await getAuroraS3Credentials(stage, auroraTenantId);
  try {
    const [result, retention] = await Promise.all([
      headObject(gatewayUrl, credentials, bucketName, objectKey),
      getObjectRetention(gatewayUrl, credentials, bucketName, objectKey),
    ]);

    const response: ObjectMetadataResponse = {
      key: result.key,
      sizeBytes: result.sizeBytes,
      lastModified: result.lastModified,
      ...(result.etag && { etag: result.etag }),
      ...(result.contentType && { contentType: result.contentType }),
      metadata: result.metadata ?? {},
      ...(result.filCid && { filCid: result.filCid }),
      ...(retention && { retention }),
    };

    return new ResponseBuilder().status(200).body<ObjectMetadataResponse>(response).build();
  } catch (err) {
    if (isNoSuchBucketError(err)) {
      return new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Bucket not found' })
        .build();
    }
    if (isNotFoundError(err)) {
      return new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Object not found' })
        .build();
    }
    throw err;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
