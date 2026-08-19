import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { OrgDeletingError } from './org-profile.js';

const LOG = '[tenant-setup-fence]';

/**
 * Decides what a refused tenant-pointer write means, and recovers from the case
 * that leaks.
 *
 * The two causes need opposite handling. A lost race is ordinary: another request
 * wrote the id first and the caller falls through to read it. A `deleting` profile
 * means this request read the profile before the fence landed, created a tenant
 * upstream, and will never get a local pointer for it — so the tenant is deleted
 * here and the caller is told the org is going.
 *
 * `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` on the write is what tells the
 * two apart, without a second read a concurrent writer could have changed.
 *
 * Returns for a lost race, throws OrgDeletingError for a deleting org, and
 * rethrows anything that is not a refusal.
 */
export async function resolveRefusedTenantWrite(params: {
  orgId: string;
  orchestratorId: string;
  tenantId: string;
  err: unknown;
  deleteTenant: () => Promise<void>;
}): Promise<void> {
  const { orgId, orchestratorId, tenantId, err, deleteTenant } = params;

  if (!(err instanceof ConditionalCheckFailedException)) throw err;
  if (err.Item?.deleting?.BOOL !== true) return;

  // A failed rollback must not mask the refusal: the caller still has to answer
  // "this org is gone" rather than "try again in a moment". The leak it leaves is
  // a tenant with no local pointer, which reconciliation against the provider's
  // tenant list is the backstop for.
  try {
    await deleteTenant();
    console.warn(`${LOG} deleted a tenant created against a deleting org`, {
      orgId,
      orchestratorId,
      tenantId,
    });
  } catch (rollbackErr) {
    console.error(`${LOG} could not delete a tenant created against a deleting org`, {
      orgId,
      orchestratorId,
      tenantId,
      error: rollbackErr,
    });
  }

  throw new OrgDeletingError(orgId);
}
