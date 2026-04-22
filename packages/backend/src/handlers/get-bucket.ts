import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket, ErrorResponse, GetBucketResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { Resource } from 'sst';
import { createClient, getBucketInfo } from '@filone/aurora-portal-client';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getAuroraPortalApiKey } from '../lib/aurora-portal.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
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
  const { orgId } = getUserInfo(event);
  const bucketName = event.pathParameters?.name;

  if (!bucketName) {
    return new ResponseBuilder().status(400).body({ message: 'Bucket name is required' }).build();
  }

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
    console.warn('Aurora tenant setup is not complete', { orgId, auroraTenantId, setupStatus });
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, auroraTenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { data, error, response } = await getBucketInfo({
    client,
    path: { tenantId: auroraTenantId, bucketName },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 404) {
      return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
    }
    throw new Error(
      `Failed to get bucket "${bucketName}" from Aurora for tenant ${auroraTenantId}`,
      {
        cause: error,
      },
    );
  }

  if (!data?.createdAt) {
    throw new Error(
      `Aurora returned incomplete data for bucket "${bucketName}" (tenant ${auroraTenantId})`,
    );
  }

  const bucket: Bucket = {
    name: data.name ?? bucketName,
    region: S3_REGION,
    createdAt: data.createdAt,
    isPublic: false,
    objectLockEnabled: data.objectLock ?? false,
    versioning: data.versioning ?? false,
    encrypted: data.encrypted ?? true,
    defaultRetention:
      data.defaultRetention && data.defaultRetention !== 'off' ? data.defaultRetention : undefined,
    retentionDuration: data.retentionDuration ?? undefined,
    retentionDurationType: data.retentionDurationType ?? undefined,
  };

  return new ResponseBuilder().status(200).body<GetBucketResponse>({ bucket }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
