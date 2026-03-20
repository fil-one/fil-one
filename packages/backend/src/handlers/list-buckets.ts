import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket, ListBucketsResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getAuroraS3Credentials, listBuckets } from '../lib/aurora-s3-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';
import type { ErrorResponse } from '@filone/shared';

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

  const stage = process.env.FILONE_STAGE!;
  const gatewayUrl = process.env.AURORA_S3_GATEWAY_URL!;

  const credentials = await getAuroraS3Credentials(stage, auroraTenantId);
  const result = await listBuckets(gatewayUrl, credentials);

  const buckets: Bucket[] = result.buckets.map((b) => ({
    name: b.name,
    region: S3_REGION,
    createdAt: b.createdAt,
    isPublic: false,
  }));

  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
