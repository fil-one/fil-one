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
 */
export interface RevocationOutcome {
  /** Revoked and delisted, in the order the pass ran. */
  revoked: AccessKeySummary[];
  /**
   * Still live, because a vendor refused. Under `stop` this holds the one key
   * the pass halted on and the caller leaves the membership unchanged; under
   * `continue` it holds every key the vendor refused, which is what an admin
   * needs when the membership has already moved.
   */
  failed: AccessKeySummary[];
}

/**
 * What a refusal means for the rest of the pass.
 *
 * `stop` before the membership write: the change will not commit, so there is
 * nothing to be gained by revoking further and the retry is the same request.
 * `continue` after it: the member already holds the narrower role, so every key
 * still above it should go, and the ones that will not have to be named.
 */
export type OnRevocationFailure = 'stop' | 'continue';

export async function revokeMemberKeys({
  orgId,
  orgProfile,
  keys,
  actor,
  reason,
  onFailure = 'stop',
}: {
  orgId: string;
  /** Read once, so several orchestrators resolve their tenant from one row. */
  orgProfile: OrgProfileItem | undefined;
  keys: readonly AccessKeyToRevoke[];
  /** Who asked. On a role change this is the admin, never the key's holder. */
  actor: AuditActor;
  reason: RevocationTrigger;
  onFailure?: OnRevocationFailure;
}): Promise<RevocationOutcome> {
  const revoked: AccessKeySummary[] = [];
  const failed: AccessKeySummary[] = [];

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
        stopping: onFailure === 'stop',
        error,
      });
      failed.push(summary);
      if (onFailure === 'stop') break;
    }
  }

  return { revoked, failed };
}

/**
 * Work whose failure must not become the caller's failure.
 *
 * Used for the tail of a membership change, after the write has committed:
 * answering with an error there would send the caller into a retry that finds
 * the work already done — the role where they wanted it, the member gone, the
 * seat moved — while the thing that actually failed was a notification. So it
 * is logged and swallowed, and the response reflects the write.
 */
export async function bestEffort<T>(
  what: () => Promise<T>,
  fallback: T,
  context: { source: string; orgId: string },
): Promise<T> {
  try {
    return await what();
  } catch (error) {
    console.error(`[${context.source}] The pass after the write did not finish`, {
      orgId: context.orgId,
      error,
    });
    return fallback;
  }
}
