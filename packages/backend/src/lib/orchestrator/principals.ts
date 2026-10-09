// Registering an org's members as principals at an `iam` orchestrator.
//
// A bucket policy naming a member the storage system does not know is refused
// whole, and a bucket's first policy travels on its own create — so a member
// who is not a principal cannot create their first bucket. This runs from
// `ensureTenantReady`, the call every policy-writing path already makes.
//
// Kept out of iam-policy-fanout.ts on purpose: that module reaches the
// orchestrator registry, and importing it from the orchestrator would close an
// import cycle.

import type { IamMethods } from '../iam-orchestrator.ts';
import { listMembers } from '../org-membership.ts';
import { addRegisteredPrincipals, getOrgProfile, registeredPrincipals } from '../org-profile.ts';

/**
 * Registers every member not already recorded on the org's PROFILE row.
 *
 * The row is the record of who exists, so the steady state costs one read and
 * sends nothing: only a member absent from that set is synced, and a newly
 * invited member is registered on the next call and never again.
 */
export async function registerMemberPrincipals(
  iam: IamMethods,
  orchestratorId: string,
  orgId: string,
  tenantId: string,
): Promise<void> {
  const registered = registeredPrincipals(await getOrgProfile(orgId), orchestratorId);
  const missing = (await listMembers(orgId)).filter((member) => !registered.has(member.userId));
  if (missing.length === 0) return;

  for (const { userId } of missing) {
    await iam.syncMember(tenantId, userId);
  }
  await addRegisteredPrincipals(
    orgId,
    orchestratorId,
    missing.map((member) => member.userId),
  );
}
