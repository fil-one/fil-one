import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket, ListBucketsResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { Resource } from 'sst';
import { createClient, listBuckets } from '@filone/aurora-portal-client';
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

  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, auroraTenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { data, error } = await listBuckets({
    client,
    path: { tenantId: auroraTenantId },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Failed to list buckets from Aurora for tenant ${auroraTenantId}`, {
      cause: error,
    });
  }

  const buckets: Bucket[] = (data?.items ?? [])
    .filter((b): b is typeof b & { name: string; createdAt: string } => !!b.name && !!b.createdAt)
    .map((b) => ({
      name: b.name,
      region: S3_REGION,
      createdAt: b.createdAt,
      isPublic: false,
      versioning: b.flags?.includes('versioned') ?? false,
      encrypted: b.flags?.includes('encrypted') ?? true,
    }));

  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
