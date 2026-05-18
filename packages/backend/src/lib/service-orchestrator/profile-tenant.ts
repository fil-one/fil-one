// Generic DynamoDB read/write helpers for per-provider tenant attributes stored
// on the ORG#{orgId}/PROFILE row.
//
// Each provider supplies its own attribute names (Aurora uses the legacy
// `setupStatus`, `auroraTenantId`, `setupFailureCount`; Fortilyx will use
// `fortilyxSetupStatus`, `fortilyxTenantId`, `fortilyxSetupFailureCount`).
// `setupStatus` values are opaque strings — providers must not compare values
// across providers, since each owns its own state-machine enum.
//
// PROFILE-row attribute bloat: with two providers this is fine; if a third
// provider gets added later, consider moving to a map attribute.

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from '../ddb-client.js';

const dynamo = getDynamoClient();

export interface TenantAttrNames {
  statusAttr: string;
  tenantIdAttr: string;
  failureCountAttr: string;
}

export interface TenantAttrs {
  tenantId?: string;
  setupStatus?: string;
  setupFailureCount?: number;
  orgName?: string;
}

const orgProfileKey = (orgId: string) => ({
  pk: { S: `ORG#${orgId}` },
  sk: { S: 'PROFILE' },
});

export async function readTenantAttrs(
  orgId: string,
  attrs: TenantAttrNames,
  options: { consistent?: boolean } = {},
): Promise<TenantAttrs | null> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: orgProfileKey(orgId),
      ConsistentRead: options.consistent,
    }),
  );

  if (!Item) return null;

  return {
    tenantId: Item[attrs.tenantIdAttr]?.S,
    setupStatus: Item[attrs.statusAttr]?.S,
    setupFailureCount: Item[attrs.failureCountAttr]?.N
      ? Number(Item[attrs.failureCountAttr].N)
      : undefined,
    orgName: Item.name?.S,
  };
}

export interface AdvanceTenantStatusOptions {
  orgId: string;
  statusAttr: string;
  expected: string;
  next: string;
  writeTenantIdAttr?: string;
  writeTenantId?: string;
}

/**
 * Atomically advance a provider's setup status. Mirrors the conditional-update
 * semantics used by Aurora's state machine: `ConditionExpression: <statusAttr>
 * = :expected`. Returns 'lost-race' on `ConditionalCheckFailedException` so
 * callers can re-read and continue from the winner's state.
 */
export async function advanceTenantStatus(
  opts: AdvanceTenantStatusOptions,
): Promise<'wrote' | 'lost-race'> {
  const setExpr =
    opts.writeTenantIdAttr && opts.writeTenantId !== undefined
      ? `SET ${opts.writeTenantIdAttr} = :tid, ${opts.statusAttr} = :status, updatedAt = :now`
      : `SET ${opts.statusAttr} = :status, updatedAt = :now`;

  const exprValues: Record<string, { S: string }> = {
    ':status': { S: opts.next },
    ':expected': { S: opts.expected },
    ':now': { S: new Date().toISOString() },
    ...(opts.writeTenantIdAttr && opts.writeTenantId !== undefined
      ? { ':tid': { S: opts.writeTenantId } }
      : {}),
  };

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: orgProfileKey(opts.orgId),
        UpdateExpression: setExpr,
        ConditionExpression: `${opts.statusAttr} = :expected`,
        ExpressionAttributeValues: exprValues,
      }),
    );
    return 'wrote';
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return 'lost-race';
    }
    throw err;
  }
}

/**
 * Atomically increment a provider's failure counter on the PROFILE row.
 * Returns the new value. The condition `attribute_exists(<statusAttr>)`
 * prevents creating an orphan PROFILE row when the org doesn't yet have a
 * record for this provider — the counter is only meaningful once setup has
 * been kicked off.
 */
export async function recordTenantSetupFailure(
  orgId: string,
  attrs: Pick<TenantAttrNames, 'statusAttr' | 'failureCountAttr'>,
): Promise<number> {
  const out = await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: orgProfileKey(orgId),
      UpdateExpression: `ADD ${attrs.failureCountAttr} :one SET updatedAt = :now`,
      ConditionExpression: `attribute_exists(${attrs.statusAttr})`,
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: new Date().toISOString() },
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(out.Attributes?.[attrs.failureCountAttr]?.N ?? '0');
}
