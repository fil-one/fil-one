import type { AuditActor, AccessKeySummary, RevocationTrigger } from '@filone/shared';
import { revokeAccessKey } from './key-revocation.js';
import { summarizeAccessKey } from './member-keys.js';
import type { AccessKeyToRevoke } from './member-keys.js';
import type { OrgProfileItem } from './org-profile.js';
import { getOrchestratorForRegion } from './service-orchestrator-registry.js';

/**
 * Revoke a member's keys, all at once, across whichever regions hold them.
 *
 * Each key on its own rather than in one call: each revocation is its own
 * audit correlation and its own row delete, so a pass that fails partway leaves
 * every key it did revoke recorded. The caller writes the role only after this
 * returns clean, which is what keeps a member's authority from ever being wider
 * at a storage vendor than the role that authorized it.
 *
 * Every key is attempted, and one refusal does not stop the rest. The trade: a
 * change that a refusal fails anyway may revoke more than a pass that stopped
 * at the first would have, since nothing has committed and those keys go for a
 * change that does not land. In exchange every failure is reported at once, the
 * retry (the same request) finds only what is left, and a member holding
 * hundreds of keys does not time the request out revoking them one by one.
 */
export interface RevocationOutcome {
  /** Revoked and delisted, in the order the keys were given. */
  revoked: AccessKeySummary[];
  /** The keys a vendor refused, in that same order. Empty when all went. */
  refused: AccessKeySummary[];
}

/** What every key in one pass shares. */
interface Pass {
  orgId: string;
  /** Read once, so several orchestrators resolve their tenant from one row. */
  orgProfile: OrgProfileItem | undefined;
  /** Who asked. On a role change this is the admin, never the key's holder. */
  actor: AuditActor;
  reason: RevocationTrigger;
}

export async function revokeMemberKeys({
  orgId,
  orgProfile,
  keys,
  actor,
  reason,
}: Pass & { keys: readonly AccessKeyToRevoke[] }): Promise<RevocationOutcome> {
  const pass = { orgId, orgProfile, actor, reason };
  const outcomes = await Promise.allSettled(keys.map((key) => revokeOne(key, pass)));

  const revoked: AccessKeySummary[] = [];
  const refused: AccessKeySummary[] = [];
  // `allSettled` answers in the order asked whatever order the vendors answered
  // in, so position is what joins an outcome back to its key.
  keys.forEach((key, index) => {
    const summary = summarizeAccessKey(key);
    const outcome = outcomes[index]!;
    if (outcome.status === 'fulfilled') {
      revoked.push(summary);
      return;
    }
    console.error('[revoke-member-keys] A key could not be revoked', {
      orgId,
      region: key.region,
      keyIdSuffix: summary.accessKeyIdSuffix,
      error: outcome.reason,
    });
    refused.push(summary);
  });

  return { revoked, refused };
}

async function revokeOne(
  key: AccessKeyToRevoke,
  { orgId, orgProfile, actor, reason }: Pass,
): Promise<void> {
  const orchestrator = getOrchestratorForRegion(key.region);
  const tenantId = orchestrator.isTenantReady(orgProfile);
  if (!tenantId) throw new Error(`No tenant on ${key.region} to revoke this key at.`);

  await revokeAccessKey({
    orgId,
    keyId: key.id,
    accessKeyId: key.accessKeyId,
    keyName: key.keyName,
    region: key.region,
    orchestrator,
    tenantId,
    actor,
    reason,
  });
}
