import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/** The raw `ORG#{orgId}/PROFILE` item from UserInfoTable. */
export type OrgProfileItem = Record<string, AttributeValue>;

export interface GetOrgProfileOptions {
  /**
   * Issue a strongly-consistent read. **Required** for callers that gate on a
   * *fail-open* attribute — above all the `deleting` fence (FIL-112), where a
   * stale read means provisioning against, or handing credentials to, an org
   * whose teardown has already started. See the read-semantics note below for
   * why mutability alone is not the test.
   */
  consistent?: boolean;
}

// Fetches the `ORG#{orgId}/PROFILE` row shared by all orchestrators, so
// callers consulting several orchestrators read the row once instead of once
// per orchestrator.
//
// Read semantics. The question is not "is the attribute mutable?" but "which
// way does a stale read fail?":
//
// - **Monotone in the safe direction → eventually consistent is fine.** The
//   tenant ids (auroraTenantId, fthTenantId) are write-once, and the setup
//   statuses (auroraSetupStatus, fthSetupStatus) only ever advance toward
//   complete. A stale read can therefore only *under*-report readiness — the
//   caller concludes "not provisioned yet" and re-drives setup, which is
//   idempotent. It can never report a tenant that is not there, nor a wrong
//   tenant id. `auroraSetupStatus` is mutable and is read this way from every
//   `isTenantReady` call site; that is correct, not a gap to be closed.
// - **Fail-open → strongly consistent is required.** `deleting` is *absent*
//   until the teardown starts, so a stale read answers "not deleting" for an
//   org that is already being torn down, and the caller proceeds. There is no
//   safe direction to be stale in. Callers gating on `deleting` must pass
//   `{ consistent: true }`; the tenant-setup flows all do.
// - No ProjectionExpression: it would not reduce consumed RCUs, and different
//   orchestrators need different attributes from the same row.
export async function getOrgProfile(
  orgId: string,
  options: GetOrgProfileOptions = {},
): Promise<OrgProfileItem | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      // Spread so the eventually-consistent call site sends no ConsistentRead
      // key at all, matching DynamoDB's default.
      ...(options.consistent ? { ConsistentRead: true } : {}),
    }),
  );
  return Item;
}

/**
 * Account deletion in progress (FIL-112): never provision against an org
 * being torn down — a tenant setup racing the teardown would orphan a live
 * tenant. Every orchestrator's tenant-setup path must call this right after
 * its `getOrgProfile(orgId, { consistent: true })`.
 */
export function assertOrgNotDeleting(orgProfile: OrgProfileItem | undefined, orgId: string): void {
  if (orgProfile?.deleting?.BOOL === true) {
    throw new Error(`Org ${orgId} is being deleted; refusing tenant setup`);
  }
}
