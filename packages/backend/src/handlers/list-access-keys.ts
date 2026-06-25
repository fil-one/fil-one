import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccessKey, AccessKeyPermission, ListAccessKeysResponse } from '@filone/shared';
import { ACCESS_KEY_PERMISSIONS, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

// Legacy un-migrated rows store the old basic tokens (read/write/list/delete) in
// `permissions`; filtering to the known S3-action set drops those so they never
// surface as permissions. After the backfill runs, `permissions` holds S3 actions.
const VALID_PERMISSIONS = new Set<string>(ACCESS_KEY_PERMISSIONS);

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const bucketFilter = event.queryStringParameters?.bucket;

  const queryInput: ConstructorParameters<typeof QueryCommand>[0] = {
    TableName: Resource.UserInfoTable.name,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `ORG#${orgId}` },
      ':skPrefix': { S: 'ACCESSKEY#' },
    },
  };

  // When a bucket filter is provided, only return keys that have access to that bucket:
  // either keys with bucketScope = 'all' or keys that include the bucket in their buckets list.
  if (bucketFilter) {
    queryInput.FilterExpression = 'bucketScope = :all OR contains(buckets, :bucket)';
    queryInput.ExpressionAttributeValues = {
      ...queryInput.ExpressionAttributeValues,
      ':all': { S: 'all' },
      ':bucket': { S: bucketFilter },
    };
  }

  const result = await getDynamoClient().send(new QueryCommand(queryInput));

  const keys: AccessKey[] = (result.Items ?? []).map((item) => {
    const record = unmarshall(item);
    return {
      id: (record.sk as string).replace('ACCESSKEY#', ''),
      keyName: record.keyName as string,
      accessKeyId: record.accessKeyId as string,
      createdAt: record.createdAt as string,
      status: record.status as AccessKey['status'],
      permissions: ((record.permissions ?? []) as string[]).filter((p): p is AccessKeyPermission =>
        VALID_PERMISSIONS.has(p),
      ),
      bucketScope: record.bucketScope as AccessKey['bucketScope'],
      buckets: record.buckets as string[] | undefined,
      region: (record.region as AccessKey['region']) ?? S3Region.EuWest1,
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
