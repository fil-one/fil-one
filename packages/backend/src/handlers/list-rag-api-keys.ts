import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListRagApiKeysResponse, RagApiKey, RagKeyBucketRef } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: RagApiKeyKeys.orgPk(orgId) },
        ':skPrefix': { S: RagApiKeyKeys.orgSkPrefix() },
      },
    }),
  );

  // Mapped field-by-field on purpose: the stored record carries `tokenHash`,
  // which must never reach a response.
  const keys: RagApiKey[] = (result.Items ?? [])
    .map((item) => {
      const record = unmarshall(item);
      const bucketScope = record.bucketScope as RagApiKey['bucketScope'];
      return {
        id: (record.sk as string).replace(RagApiKeyKeys.orgSkPrefix(), ''),
        keyName: record.keyName as string,
        keyPrefix: record.keyPrefix as string,
        bucketScope,
        ...(bucketScope === 'specific'
          ? { buckets: record.buckets as RagKeyBucketRef[] | undefined }
          : {}),
        createdAt: record.createdAt as string,
        ...(record.creatorEmail ? { creatorEmail: record.creatorEmail as string } : {}),
        ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt as string } : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return new ResponseBuilder().status(200).body<ListRagApiKeysResponse>({ keys }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
