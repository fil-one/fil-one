import type { AuditActor, AccessKeySummary, RevocationTrigger } from '@filone/shared';
import { revokeAccessKey } from './key-revocation.js';
import { summarizeAccessKey } from './member-keys.js';
import type { AccessKeyToRevoke } from './member-keys.js';
import type { OrgProfileItem } from './org-profile.js';
import { getOrchestratorForRegion } from './service-orchestrator-registry.js';

/**
 * Revoke a member's keys, one at a time, across whichever regions hold them.
 *
 * Key by key rather than in one call: each revocation is its own audit
 * correlation and its own row delete, so a pass that fails halfway leaves every
 * key it did revoke recorded. The caller writes the role only after this
 * returns clean, which is what keeps a member's authority from ever being wider
 * at a storage vendor than the role that authorized it.
 *
 * The pass halts at the first refusal. Nothing has committed yet, so the change
 * will not either, and revoking further buys nothing: the retry is the same
 * request, which finds fewer keys.
 */
export interface RevocationOutcome {
  /** Revoked and delisted, in the order the pass ran. */
  revoked: AccessKeySummary[];
  /** The key a vendor refused, which halted the pass. Absent when all went. */
  refused?: AccessKeySummary;
}

export async function revokeMemberKeys({
  orgId,
  orgProfile,
  keys,
  actor,
  reason,
}: {
  orgId: string;
  /** Read once, so several orchestrators resolve their tenant from one row. */
  orgProfile: OrgProfileItem | undefined;
  keys: readonly AccessKeyToRevoke[];
  /** Who asked. On a role change this is the admin, never the key's holder. */
  actor: AuditActor;
  reason: RevocationTrigger;
}): Promise<RevocationOutcome> {
  const revoked: AccessKeySummary[] = [];
  let refused: AccessKeySummary | undefined;

  for (const key of keys) {
    const summary = summarizeAccessKey(key);
    try {
      const orchestrator = getOrchestratorForRegion(key.region);
      const tenantId = orchestrator.isTenantReady(orgProfile);
      if (!tenantId) {
        throw new Error(`No tenant on ${key.region} to revoke this key at.`);
      }

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
      revoked.push(summary);
    } catch (error) {
      console.error('[revoke-member-keys] A key could not be revoked', {
        orgId,
        region: key.region,
        keyIdSuffix: summary.accessKeyIdSuffix,
        revoked: revoked.length,
        error,
      });
      refused = summary;
      break;
    }
  }

  return { revoked, ...(refused ? { refused } : {}) };
}
