import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { withinScope, type KeyScope } from './key-scope.js';

/**
 * How many access keys the caller can actually see.
 *
 * The dashboard's API Keys card sits next to a "View all" link, so its number
 * has to be the number of rows that link leads to. That means counting the same
 * way the list route does: the org's `ACCESSKEY#` rows, narrowed by the caller's
 * {@link KeyScope}, so a Member holding only `keys.manage_own` is counted the
 * keys they created and nothing else.
 *
 * The alternative, the orchestrator's `keyCount` quota snapshot, counts a
 * different population (every key the tenant holds, including the system
 * `filone-console` key and rows with no DynamoDB record) and lags behind writes,
 * which is what made the two screens disagree.
 *
 * Only `createdBy` and `recovered` are projected: scope is the sole predicate,
 * and a count has no use for the rest of the row.
 */
export async function countAccessKeysInScope(orgId: string, scope: KeyScope): Promise<number> {
  // No key belongs to this caller's view, so no query can change the answer.
  if (scope.sees === 'none') return 0;

  let count = 0;
  let startKey: Record<string, unknown> | undefined;

  // Paginated because this is a count: a truncated page would silently undercount,
  // which is the class of bug this function exists to fix.
  do {
    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `ORG#${orgId}` },
          ':skPrefix': { S: 'ACCESSKEY#' },
        },
        ProjectionExpression: 'createdBy, recovered',
        ...(startKey && { ExclusiveStartKey: startKey as never }),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      const inScope = withinScope(scope, {
        createdBy: record.createdBy as string | undefined,
        recovered: record.recovered as boolean | undefined,
      });
      if (inScope) count += 1;
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return count;
}
