import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AccessKey, GranularPermission } from '@filone/shared';
import { S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { AccessKeyKeys, DEFAULT_ACCESS_KEY_REGION } from './dynamo-records.ts';
import { withinScope, type KeyScope } from './key-scope.ts';

/** Narrows a scoped listing to keys touching one bucket, or minted in one region. */
export interface AccessKeyScopeFilters {
  bucketFilter?: string;
  regionFilter?: string;
}

/**
 * The access keys a caller can actually see, read from their stored rows.
 *
 * The dashboard's API Keys card sits next to a "View all" link, so its number
 * has to be the number of rows that link leads to. That means reading the same
 * rows the list route does: the org's `ACCESSKEY#` rows, narrowed by the
 * caller's {@link KeyScope}, so a Member holding only `keys.manage_own` sees the
 * keys they created and nothing else.
 *
 * The alternative, the orchestrator's `keyCount` quota snapshot, counts a
 * different population (every key the tenant holds, including the system
 * `filone-console` key and rows with no DynamoDB record) and lags behind
 * writes, which is what made the dashboard and this listing disagree.
 */
export async function getAccessKeysInScope(
  orgId: string,
  scope: KeyScope,
  filters: AccessKeyScopeFilters = {},
): Promise<AccessKey[]> {
  // No key belongs to this caller's view, so no query can change the answer.
  if (scope.sees === 'none') return [];

  const queryInput = buildQueryInput(orgId, filters);
  const keys: AccessKey[] = [];
  let startKey: Record<string, unknown> | undefined;

  // Paginated because a truncated page would silently drop keys the caller
  // owns, which is the class of bug this function exists to fix.
  do {
    const result = await runQuery(queryInput, startKey, orgId, filters);

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      const inScope = withinScope(scope, {
        createdBy: record.createdBy as string | undefined,
        recovered: record.recovered as boolean | undefined,
      });
      if (inScope) keys.push(toAccessKey(record));
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return keys;
}

type QueryInput = ConstructorParameters<typeof QueryCommand>[0];

function buildQueryInput(
  orgId: string,
  { bucketFilter, regionFilter }: AccessKeyScopeFilters,
): QueryInput {
  const values: Record<string, { S: string }> = {
    ':pk': { S: AccessKeyKeys.orgPk(orgId) },
    ':skPrefix': { S: AccessKeyKeys.keySkPrefix() },
  };
  const names: Record<string, string> = {};
  const filterExpressions: string[] = [];

  // When a bucket filter is provided, only return keys that have access to that bucket:
  // either keys with bucketScope = 'all' or keys that include the bucket in their buckets list.
  if (bucketFilter) {
    filterExpressions.push('(bucketScope = :all OR contains(buckets, :bucket))');
    values[':all'] = { S: 'all' };
    values[':bucket'] = { S: bucketFilter };
  }

  // Access keys are region-scoped: a key created in one region cannot operate on
  // buckets in another — not even a key scoped to all buckets, since "all buckets"
  // only spans the key's own region. `region` is a DynamoDB reserved word, hence #region.
  if (regionFilter) {
    // Rows written before regions existed carry no `region` attribute and belong to
    // eu-west-1, matching the fallback applied when mapping rows below.
    filterExpressions.push(
      regionFilter === S3Region.EuWest1
        ? '(#region = :region OR attribute_not_exists(#region))'
        : '#region = :region',
    );
    names['#region'] = 'region';
    values[':region'] = { S: regionFilter };
  }

  return {
    TableName: Resource.UserInfoTable.name,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: values,
    ...(filterExpressions.length > 0 && { FilterExpression: filterExpressions.join(' AND ') }),
    ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
  };
}

// Attribute a 500 from this query: on its own the error names neither the org nor
// the filters in play, which are the only thing that varies the query shape.
async function runQuery(
  queryInput: QueryInput,
  startKey: Record<string, unknown> | undefined,
  orgId: string,
  { bucketFilter, regionFilter }: AccessKeyScopeFilters,
) {
  try {
    return await getDynamoClient().send(
      new QueryCommand({
        ...queryInput,
        ...(startKey && { ExclusiveStartKey: startKey as never }),
      }),
    );
  } catch (error) {
    console.error('[access-key-inventory] Access key query failed', {
      orgId,
      bucketFilter: bucketFilter ?? null,
      regionFilter: regionFilter ?? null,
      error,
    });
    throw error;
  }
}

function toAccessKey(record: Record<string, unknown>): AccessKey {
  return {
    id: (record.sk as string).replace(AccessKeyKeys.keySkPrefix(), ''),
    keyName: record.keyName as string,
    accessKeyId: record.accessKeyId as string,
    createdAt: record.createdAt as string,
    status: record.status as AccessKey['status'],
    permissions: record.permissions as AccessKey['permissions'],
    granularPermissions:
      (record.granularPermissions as GranularPermission[] | undefined) ?? undefined,
    bucketScope: record.bucketScope as AccessKey['bucketScope'],
    buckets: record.buckets as string[] | undefined,
    region: (record.region as AccessKey['region']) ?? DEFAULT_ACCESS_KEY_REGION,
    expiresAt: (record.expiresAt as string | undefined) ?? null,
    // Shipped so the console can gate the per-row revoke button on the same
    // rule the delete route enforces.
    ...(record.createdBy ? { createdBy: record.createdBy as string } : {}),
  };
}

/** How many access keys the caller can actually see. See {@link getAccessKeysInScope}. */
export async function countAccessKeysInScope(orgId: string, scope: KeyScope): Promise<number> {
  return (await getAccessKeysInScope(orgId, scope)).length;
}
