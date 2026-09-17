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
import { accessKeyMintSeqUnchangedCheck } from './access-key-mint-seq.ts';
import type { KeyMintFence } from './access-key-mint-seq.ts';
import { auditEvent, commitAudited, twoPhaseAudit } from './audit.ts';
import type { AuditCorrelation } from './audit.ts';
import { cancelledLabels } from './membership-changes.ts';
import type { AccessKeyToRevoke } from './member-keys.ts';
import type { OrgProfileItem } from './org-profile.ts';
import { revokeMemberKeys } from './revoke-member-keys.ts';

type Response = APIGatewayProxyStructuredResultV2;

/**
 * What the commit did. `keyMinted` carries no `revoked` field on purpose: a
 * caller cannot reach `revoked` without answering the fence first, which is what
 * keeps the answer's wording with the flow that knows whose key it was.
 */
export type CommitOutcome =
  | { revoked: AccessKeySummary[] }
  | { response: Response }
  /** The fence refused. These keys went before it did. */
  | { keyMinted: AccessKeySummary[] };

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
 * The pass reads a list, and a key minted after that reading is not on it. A
 * mint under a role that has already narrowed is discarded by the request that
 * created it (`create-access-key.ts`); the reverse ordering is refused by the
 * fence appended here, which turns the change into a retry whose listing
 * includes the key (`lib/access-key-mint-seq.ts`).
 *
 * A change that revokes no key stays one transaction and one event. One that
 * does opens a two-phase pair around the pass, and the completion rides the
 * membership items carrying the revoked ids, so the change and its record stay
 * atomic — ids rather than a count, because each revocation is its own
 * `key.deleted` and the ids are what join them.
 *
 * Which item cancelled means something different to each change, so the answer
 * is the caller's. Whichever it gives, the revoked keys are gone and the
 * member's clients are already broken, so the member is told first and the
 * response names them.
 */
export async function commitAfterRevokingKeys<T extends RevocationAuditEventType>({
  items,
  keys,
  fence,
  orgId,
  orgProfile,
  actor,
  trigger,
  auditEventType,
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
  /**
   * The sequence the listing was taken against, from
   * {@link reviewKeysForRoleChange}. Undefined only for a change that revokes
   * nothing by definition: a widening strands no key, so one minted alongside it
   * is covered by the wider role. Required rather than optional so a flow that
   * revokes cannot silently omit the fence and strand the key this exists to
   * catch.
   */
  fence: KeyMintFence | undefined;
  orgId: string;
  /** Read once, so several orchestrators resolve their tenant from one row. */
  orgProfile: OrgProfileItem | undefined;
  actor: AuditActor;
  trigger: RevocationTrigger;
  auditEventType: T;
  subject: AuditSubject;
  details: AuditEventDetails[T];
  /** Log prefix for a cancellation that lands after a revocation. */
  source: string;
  /**
   * The transaction cancelled, and these keys are gone regardless. May throw:
   * the org-deletion fence has no remedy and leaves through the shared error.
   */
  onCancelled: (err: unknown, revoked: AccessKeySummary[]) => Promise<Response> | Response;
  /** Vendors refused these, so nothing was written; the revoked ones are gone regardless. */
  onRefused: (refused: AccessKeySummary[], revoked: AccessKeySummary[]) => Response;
  /** Omitted by the flow whose key holder IS the caller, already answered. */
  notifyMember?: (revoked: AccessKeySummary[]) => Promise<void>;
}): Promise<CommitOutcome> {
  // `onCancelled` runs outside every `try` here: a thrown `OrgDeletingError` is
  // the fence's 410 and must reach the error handler unwrapped. So each write
  // only captures what it threw, and the answer follows the block. Wrapped
  // rather than bare, so a thrown `undefined` still counts as a cancellation.
  // Appended last, so the caller's own labels still line up with their items and
  // the fence sits at a position only this function knows.
  const fenced = fence ? [...items, accessKeyMintSeqUnchangedCheck(orgId, fence)] : items;

  if (keys.length === 0) {
    let cancelled: { error: unknown } | undefined;
    try {
      await commitAudited({
        items: fenced,
        event: auditEvent({ type: auditEventType, actor, orgId, subject, details }),
      });
    } catch (error) {
      cancelled = { error };
    }
    if (cancelled) {
      if (fenceRefused(cancelled.error, fence, items.length)) return { keyMinted: [] };
      return { response: await onCancelled(cancelled.error, []) };
    }
    return { revoked: [] };
  }

  // `fail-closed`, or the membership write would silently gain
  // `retry-without-audit` — a mode that exists for revocations, where an audit
  // outage must never keep a leaked key live, and for nothing else.
  const correlation = await twoPhaseAudit({
    type: auditEventType,
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

  if (pass.refused.length > 0) {
    await correlation.complete({ outcome: 'failed', details: revokedIds });
    await notifyMember?.(pass.revoked);
    return { response: onRefused(pass.refused, pass.revoked) };
  }

  const cancelled = await captured(() =>
    correlation.complete({ outcome: 'succeeded', details: revokedIds, items: fenced }),
  );
  if (!cancelled) return { revoked: pass.revoked };

  console.error(`[${source}] The write cancelled after revoking keys`, {
    orgId,
    revoked: pass.revoked.length,
  });
  await closeCancelledIntent(correlation, revokedIds, { source, orgId });
  await notifyMember?.(pass.revoked);
  if (fenceRefused(cancelled.error, fence, items.length)) return { keyMinted: pass.revoked };
  return { response: await onCancelled(cancelled.error, pass.revoked) };
}

/**
 * Close the intent the cancelled transaction took with it.
 *
 * The succeeded completion rode the membership items, so it cancelled too and
 * the intent is still open. Every return path closes its own, including the ones
 * that changed nothing (`lib/audit.ts`), or a dangling intent cannot be told
 * from a process that died mid-flight.
 *
 * Logged rather than thrown: the keys are gone and the caller needs the refusal
 * that names them, not a fault about bookkeeping on top of it.
 */
async function closeCancelledIntent<T extends RevocationAuditEventType>(
  correlation: AuditCorrelation<T>,
  details: Partial<AuditEventDetails[T]>,
  { source, orgId }: { source: string; orgId: string },
): Promise<void> {
  const unclosed = await captured(() => correlation.complete({ outcome: 'failed', details }));
  if (!unclosed) return;

  console.error(`[${source}] The cancelled write's own completion did not land`, {
    orgId,
    error: unclosed.error,
  });
}

/** What a write threw, wrapped so a thrown `undefined` still counts as a failure. */
async function captured(write: () => Promise<void>): Promise<{ error: unknown } | undefined> {
  try {
    await write();
    return undefined;
  } catch (error) {
    return { error };
  }
}

/**
 * Whether the fence's own item is the only thing that cancelled. It sits one
 * past the caller's, so `cancelledLabels` needs no names for those — only the
 * one this function appended.
 *
 * No fence, no refusal: the position named here would be the audit item
 * `commitAudited` appends, and nothing there is a mint.
 *
 * The caller's failures come first, the way `commitAudited` puts the mutation's
 * ahead of the audit item's: a change refused because the org is being torn down
 * has no retry, and answering "a key was minted, try again" would send an admin
 * round a loop that cannot end.
 */
function fenceRefused(err: unknown, fence: KeyMintFence | undefined, callerItems: number): boolean {
  if (!fence) return false;
  const labels = [...Array.from({ length: callerItems }, () => 'caller'), 'fence'];
  const failed = cancelledLabels(err, labels);
  return failed.length > 0 && failed.every((label) => label === 'fence');
}
