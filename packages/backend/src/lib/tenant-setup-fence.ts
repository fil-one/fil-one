import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { OrgDeletingError } from './org-profile.js';

const LOG = '[tenant-setup-fence]';

/**
 * Handles a refused tenant-pointer write, which always leaves an upstream tenant
 * with no local pointer.
 *
 * Neither caller's condition names the tenant-id attribute, so a concurrent
 * writer cannot refuse this write — it overwrites the attribute instead. That
 * leaves two causes and both are fatal: the profile is fencing us (`deleting`),
 * or there is no profile row at all. Either way the tenant is deleted here and
 * the caller must not report it ready.
 *
 * `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` on the write names which,
 * without a second read.
 */
export async function resolveRefusedTenantWrite(params: {
  orgId: string;
  orchestratorId: string;
  tenantId: string;
  err: unknown;
  deleteTenant: () => Promise<void>;
}): Promise<never> {
  const { orgId, orchestratorId, tenantId, err, deleteTenant } = params;

  if (!(err instanceof ConditionalCheckFailedException)) throw err;

  const deleting = err.Item?.deleting?.BOOL === true;
  const context = { orgId, orchestratorId, tenantId, deleting };

  // A failed rollback must not mask the refusal: the caller still has to answer
  // "this org is gone" rather than "try again in a moment". The leak it leaves is
  // a tenant with no local pointer, which reconciliation against the provider's
  // tenant list is the backstop for.
  try {
    await deleteTenant();
    console.warn(`${LOG} deleted a tenant that could not be recorded`, context);
  } catch (rollbackErr) {
    console.error(`${LOG} could not delete a tenant that was not recorded`, {
      ...context,
      error: rollbackErr,
    });
  }

  if (deleting) throw new OrgDeletingError(orgId);
  throw new Error(`${LOG} org ${orgId} has no profile row to record a tenant against`);
}
