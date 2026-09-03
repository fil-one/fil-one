import {
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/** The raw `ORG#{orgId}/PROFILE` item from UserInfoTable. */
export type OrgProfileItem = Record<string, AttributeValue>;

// Fetches the `ORG#{orgId}/PROFILE` row shared by all orchestrators, so
// callers consulting several orchestrators read the row once instead of once
// per orchestrator.
//
// Read semantics:
// - Eventually consistent by default: tenant-id attributes (auroraTenantId,
//   fthTenantId) are write-once, so a stale read can only transiently report
//   "not provisioned" right after setup — never a wrong tenant id. Setup
//   flows that need read-after-write (processTenantSetup) issue their own
//   ConsistentRead and do not go through this helper.
// - `consistentRead` is for the callers whose attribute is not write-once.
//   `auth0OrgId` is one: it is set when an org adopts SSO and cleared if it
//   leaves, and the gate reading it decides which sessions may enter the org,
//   so a stale replica must not admit a session the current row refuses.
// - No ProjectionExpression: it would not reduce consumed RCUs, and different
//   orchestrators need different attributes from the same row.
export async function getOrgProfile(
  orgId: string,
  options: { consistentRead?: boolean } = {},
): Promise<OrgProfileItem | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      ...(options.consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  return Item;
}

/**
 * Whether the org is being deleted. The fence fails open when absent, so pass
 * `{ consistent: true }` anywhere the answer gates a write — a stale read can
 * miss a fence that has already landed.
 */
export async function isOrgDeleting(
  orgId: string,
  options?: { consistent?: boolean },
): Promise<boolean> {
  const orgProfile = await getOrgProfile(orgId, { consistentRead: options?.consistent });
  return orgProfile?.deleting?.BOOL === true;
}

/**
 * Whether background work should leave this org alone — it is being deleted,
 * or its profile row is already gone.
 *
 * Distinct from {@link isOrgDeleting}, which reports false for a missing row.
 * That is right for request paths, where the row always exists and a stale read
 * must not refuse a live org; it is wrong for a scheduled job, whose whole
 * candidate list can outlive the rows it was built from.
 */
export async function isOrgDeletedOrDeleting(orgId: string): Promise<boolean> {
  const orgProfile = await getOrgProfile(orgId, { consistentRead: true });
  return orgProfile === undefined || orgProfile.deleting?.BOOL === true;
}

/** Thrown when a write is refused because the org is being deleted. */
export class OrgDeletingError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`Organization ${orgId} is being deleted`);
    this.name = 'OrgDeletingError';
    this.orgId = orgId;
  }
}

/**
 * Commits `items` only if the org is not being deleted, mapping the refusal to
 * {@link OrgDeletingError}. For writes that create org-owned resources — a
 * condition on the row being written cannot fence a write that creates it.
 */
export async function sendDeletionGuardedWrite(
  orgId: string,
  items: TransactWriteItem[],
): Promise<void> {
  try {
    await dynamo.send(
      new TransactWriteItemsCommand({ TransactItems: [orgNotDeletingCheck(orgId), ...items] }),
    );
  } catch (err) {
    if (isGuardRejection(err)) throw new OrgDeletingError(orgId);
    throw err;
  }
}

/**
 * The guard as a transaction item, for callers assembling their own
 * TransactWriteItems. Must be item 0, since CancellationReasons is positional.
 */
export function orgNotDeletingCheck(orgId: string): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      // A ConditionCheck on a missing item reads every attribute as absent, so
      // attribute_not_exists(deleting) alone would pass for an org that has no
      // profile row. attribute_exists(pk) refuses that case instead.
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
    },
  };
}

// Positional: reason 0 is the guard, so a caller's own failed condition reports
// at its own index and is rethrown rather than mislabelled as a deletion.
// Exported with {@link orgNotDeletingCheck} for callers that assemble their own
// transaction and need to map the same rejection.
export function isGuardRejection(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
  );
}

/**
 * An org's display name, or '' when the profile row is missing or unreadable.
 *
 * For callers naming orgs the user is not acting in — the switcher's list — one
 * unreadable profile should cost that entry its name, not the whole response,
 * so the read failure is logged and swallowed here rather than raised.
 */
export async function resolveOrgName(orgId: string): Promise<string> {
  return (await resolveOrgSummary(orgId)).name;
}

/**
 * The identity fields the org switcher and `/me` need for one org: name, slug,
 * and logo. `name` and `slug` default to `''` for an unreadable or missing
 * profile — the same "named empty rather than failing the response" contract
 * {@link resolveOrgName} has always made — and `logoUrl` is left absent rather
 * than defaulted, since a caller with no logo and a caller whose read failed
 * both fall back to the generated monogram identically.
 */
export interface OrgProfileSummary {
  name: string;
  slug: string;
  logoUrl?: string;
}

/**
 * {@link resolveOrgName}'s fuller sibling, for callers naming orgs the user is
 * not acting in — the switcher's list — that also need the org's slug and
 * logo. One unreadable profile costs that entry its identity, not the whole
 * response, so the read failure is logged and swallowed here rather than
 * raised.
 */
export async function resolveOrgSummary(orgId: string): Promise<OrgProfileSummary> {
  try {
    const profile = await getOrgProfile(orgId);
    return {
      name: profile?.name?.S ?? '',
      slug: profile?.slug?.S ?? '',
      ...(profile?.logoUrl?.S ? { logoUrl: profile.logoUrl.S } : {}),
    };
  } catch (err) {
    console.error('[org-profile] Org profile read failed — naming the org empty', {
      orgId,
      error: err,
    });
    return { name: '', slug: '' };
  }
}
