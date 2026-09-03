import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type {
  AccessKeySummary,
  AuditActor,
  AuditEventDetails,
  AuditSubject,
  RevocationTrigger,
  TwoPhaseAuditEventType,
} from '@filone/shared';
import { auditEvent, commitAudited, twoPhaseAudit } from './audit.js';
import type { AccessKeyToRevoke } from './member-keys.js';
import type { OrgProfileItem } from './org-profile.js';
import { revokeMemberKeys } from './revoke-member-keys.js';

type Response = APIGatewayProxyStructuredResultV2;

/**
 * The two-phase event types whose payload can carry the ids of keys a change
 * revoked. Derived, not listed: an event opts in by declaring the field, and
 * one without it is a compile error at the call site.
 */
export type RevocationAuditEventType = {
  [T in TwoPhaseAuditEventType]: AuditEventDetails[T] extends { revokedKeys?: string[] }
    ? T
    : never;
}[TwoPhaseAuditEventType];

/**
 * Revoke the keys a membership change strands, then commit the change.
 *
 * The order is the whole of it. An access key carries its own permission set,
 * fixed when it was minted, and nothing at Aurora or FTH evaluates it against
 * the role its holder now has. So the keys the member could no longer mint are
 * revoked at the vendor BEFORE the membership is written: a member is never
 * wider at a storage vendor than the role the console records for them.
 *
 * The pass reads a list, and a key minted after that reading is not on it. Both
 * ends of that window belong to the mint rather than here: its key row carries
 * a `ConditionCheck` on the creator's role, and it reads the role once more
 * after the row lands (`create-access-key.ts`). A key that outlives this pass
 * is discarded by the request that created it.
 *
 * A change that revokes no key touches no vendor, so it stays one transaction
 * and one event, the form every membership change took in M1. One that does
 * opens a two-phase pair around the pass, and the completion rides the
 * membership items with the revoked ids on it, so the change and its record
 * stay atomic. Ids rather than a count, because each revocation is its own
 * `key.deleted` outside this transaction and the ids are what join them.
 *
 * The three ways it can fail are the caller's to answer, because none is
 * expressible as data here: which item cancelled means something different to
 * each change, and reading it may take another lookup. Whatever the answer, the
 * keys already revoked are gone and the member's clients are already broken, so
 * the member is told before the caller is answered and the response names them.
 * The retry is the same request, which finds fewer keys: every completed
 * revocation deleted its row.
 */
export async function commitAfterRevoking<T extends RevocationAuditEventType>({
  items,
  keys,
  orgId,
  orgProfile,
  actor,
  trigger,
  type,
  subject,
  details,
  source,
  onCancelled,
  onRefused,
  notifyMember,
}: {
  /** The membership write, behind whatever fence the caller placed as item 0. */
  items: TransactWriteItem[];
  keys: readonly AccessKeyToRevoke[];
  orgId: string;
  /** Read once, so several orchestrators resolve their tenant from one row. */
  orgProfile: OrgProfileItem | undefined;
  actor: AuditActor;
  trigger: RevocationTrigger;
  type: T;
  subject: AuditSubject;
  details: AuditEventDetails[T];
  /** Log prefix for a cancellation that lands after a revocation. */
  source: string;
  /**
   * The transaction cancelled, and these keys are gone regardless. May throw:
   * the org-deletion fence has no remedy and leaves through the shared error.
   */
  onCancelled: (err: unknown, revoked: AccessKeySummary[]) => Promise<Response> | Response;
  /** A vendor refused, so nothing was written and these keys are gone regardless. */
  onRefused: (refused: AccessKeySummary, revoked: AccessKeySummary[]) => Response;
  /** Omitted by the flow whose key holder IS the caller, already answered. */
  notifyMember?: (revoked: AccessKeySummary[]) => Promise<void>;
}): Promise<{ revoked: AccessKeySummary[] } | { response: Response }> {
  // `onCancelled` runs outside any `try` here: a thrown `OrgDeletingError` is
  // the fence's 410 and must reach the error handler unwrapped.
  if (keys.length === 0) {
    const cancelled = await attempt(() =>
      commitAudited({
        items,
        event: auditEvent({ type, actor, orgId, subject, details }),
      }),
    );
    if (cancelled) return { response: await onCancelled(cancelled.error, []) };
    return { revoked: [] };
  }

  // `fail-closed`, or the membership write would silently gain
  // `retry-without-audit` — a mode that exists for revocations, where an audit
  // outage must never keep a leaked key live, and for nothing else.
  const correlation = await twoPhaseAudit({
    type,
    mode: 'fail-closed',
    actor,
    orgId,
    subject,
    details,
  });

  const pass = await revokeMemberKeys({ orgId, orgProfile, keys, actor, reason: trigger });
  // An indexed access over the union cannot be narrowed to prove the one field,
  // so this is the one place the ids merge is asserted rather than checked.
  const revokedIds = (
    pass.revoked.length > 0 ? { revokedKeys: pass.revoked.map((key) => key.id) } : {}
  ) as Partial<AuditEventDetails[T]>;

  if (pass.refused) {
    await correlation.complete({ outcome: 'failed', details: revokedIds });
    await notifyMember?.(pass.revoked);
    return { response: onRefused(pass.refused, pass.revoked) };
  }

  const cancelled = await attempt(() =>
    correlation.complete({ outcome: 'succeeded', details: revokedIds, items }),
  );
  if (cancelled) {
    console.error(`[${source}] The write cancelled after revoking keys`, {
      orgId,
      revoked: pass.revoked.length,
    });
    await notifyMember?.(pass.revoked);
    return { response: await onCancelled(cancelled.error, pass.revoked) };
  }

  return { revoked: pass.revoked };
}

/** The error a write threw, as a value, so what answers it runs outside the `try`. */
async function attempt(write: () => Promise<void>): Promise<{ error: unknown } | undefined> {
  try {
    await write();
    return undefined;
  } catch (error) {
    return { error };
  }
}
