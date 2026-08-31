import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccessKey, GranularPermission, ListAccessKeysResponse } from '@filone/shared';
import { S3Region, isSupportedRegion } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { keyScope, withinScope } from '../lib/key-scope.js';
import { ResponseBuilder, unsupportedRegionResponse } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const bucketFilter = event.queryStringParameters?.bucket;
  // Optional: callers that omit `region` get keys from every region, which is what
  // the API keys page lists.
  const regionFilter = event.queryStringParameters?.region;

  if (regionFilter && !isSupportedRegion(regionFilter, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(regionFilter);
  }

  const values: Record<string, { S: string }> = {
    ':pk': { S: `ORG#${orgId}` },
    ':skPrefix': { S: 'ACCESSKEY#' },
  };
  const names: Record<string, string> = {};
  const filters: string[] = [];

  // When a bucket filter is provided, only return keys that have access to that bucket:
  // either keys with bucketScope = 'all' or keys that include the bucket in their buckets list.
  if (bucketFilter) {
    filters.push('(bucketScope = :all OR contains(buckets, :bucket))');
    values[':all'] = { S: 'all' };
    values[':bucket'] = { S: bucketFilter };
  }

  // Access keys are region-scoped: a key created in one region cannot operate on
  // buckets in another — not even a key scoped to all buckets, since "all buckets"
  // only spans the key's own region. `region` is a DynamoDB reserved word, hence #region.
  if (regionFilter) {
    // Rows written before regions existed carry no `region` attribute and belong to
    // eu-west-1, matching the fallback applied when mapping rows below.
    filters.push(
      regionFilter === S3Region.EuWest1
        ? '(#region = :region OR attribute_not_exists(#region))'
        : '#region = :region',
    );
    names['#region'] = 'region';
    values[':region'] = { S: regionFilter };
  }

  const queryInput: ConstructorParameters<typeof QueryCommand>[0] = {
    TableName: Resource.UserInfoTable.name,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: values,
    ...(filters.length > 0 && { FilterExpression: filters.join(' AND ') }),
    ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
  };

  // Attribute a 500 from this handler: on its own the error names neither the org nor
  // the filters in play, which are the only thing that varies the query shape.
  let result;
  try {
    result = await getDynamoClient().send(new QueryCommand(queryInput));
  } catch (error) {
    console.error('[list-access-keys] Access key query failed', {
      orgId,
      bucketFilter: bucketFilter ?? null,
      regionFilter: regionFilter ?? null,
      error,
    });
    throw error;
  }

  // A caller holding only `keys.manage_own` sees the keys they created and
  // nothing else. The narrowing is here rather than in a FilterExpression
  // because the query already reads the org's partition to answer the bucket and
  // region filters, and one predicate over the page is cheaper than a second
  // shape of query to maintain.
  const scope = keyScope(event);

  const keys: AccessKey[] = (result.Items ?? [])
    .map((item) => unmarshall(item))
    .filter((record) =>
      withinScope(scope, {
        createdBy: record.createdBy as string | undefined,
        recovered: record.recovered as boolean | undefined,
      }),
    )
    .map((record) => ({
      id: (record.sk as string).replace('ACCESSKEY#', ''),
      keyName: record.keyName as string,
      accessKeyId: record.accessKeyId as string,
      createdAt: record.createdAt as string,
      status: record.status as AccessKey['status'],
      permissions: record.permissions as AccessKey['permissions'],
      granularPermissions:
        (record.granularPermissions as GranularPermission[] | undefined) ?? undefined,
      bucketScope: record.bucketScope as AccessKey['bucketScope'],
      buckets: record.buckets as string[] | undefined,
      region: (record.region as AccessKey['region']) ?? S3Region.EuWest1,
      expiresAt: (record.expiresAt as string | undefined) ?? null,
      // Shipped so the console can gate the per-row revoke button on the same
      // rule the delete route enforces.
      ...(record.createdBy ? { createdBy: record.createdBy as string } : {}),
    }));

  return new ResponseBuilder().status(200).body<ListAccessKeysResponse>({ keys }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
