import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BucketAnalyticsResponse, ErrorResponse } from '@filone/shared';
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
import { getBucketStorageSamples } from '../lib/aurora-backoffice.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const bucketName = event.pathParameters?.name;

  if (!bucketName) {
    return new ResponseBuilder().status(400).body({ message: 'Bucket name is required' }).build();
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

  // Verify bucket belongs to this tenant before fetching partner-level metrics
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, auroraTenantId);

  const portalClient = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { error: bucketError, response: bucketResponse } = await getBucketInfo({
    client: portalClient,
    path: { tenantId: auroraTenantId, bucketName },
    throwOnError: false,
  });

  if (bucketError) {
    if (bucketResponse?.status === 404) {
      return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
    }
    throw new Error(
      `Failed to verify bucket "${bucketName}" ownership for tenant ${auroraTenantId}`,
      { cause: bucketError },
    );
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const samples = await getBucketStorageSamples({
    bucketName,
    from: thirtyDaysAgo.toISOString(),
    to: now.toISOString(),
    window: '720h',
  });

  const latest = samples.at(-1);

  const response: BucketAnalyticsResponse = {
    objectCount: latest?.objectCount ?? 0,
    bytesUsed: latest?.bytesUsed ?? 0,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
