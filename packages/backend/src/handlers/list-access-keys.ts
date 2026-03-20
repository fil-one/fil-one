import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccessKey, ListAccessKeysResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
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
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    }),
  );

  const keys: AccessKey[] = (result.Items ?? []).map((item) => {
    const record = unmarshall(item);
    return {
      id: (record.sk as string).replace('ACCESSKEY#', ''),
      keyName: record.keyName as string,
      accessKeyId: record.accessKeyId as string,
      createdAt: record.createdAt as string,
      status: record.status as AccessKey['status'],
      permissions: record.permissions as AccessKey['permissions'],
      bucketScope: record.bucketScope as AccessKey['bucketScope'],
      buckets: record.buckets as string[] | undefined,
      expiresAt: (record.expiresAt as string | undefined) ?? null,
    };
  });

  return new ResponseBuilder().status(200).body<ListAccessKeysResponse>({ keys }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
