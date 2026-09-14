import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, NO_ROLE, auditKeyIdSuffix, canRetainAccessKey } from '@filone/shared';
import type {
  AccessKeyPermissions,
  AuditActor,
  ErrorResponse,
  ExcessKeyPermission,
  S3Region,
} from '@filone/shared';
import { Resource } from 'sst';
import { accessKeyMintSeqItem } from './access-key-mint-seq.ts';
import type { AuditCorrelation } from './audit.ts';
import type { AccessKeyRecord } from './dynamo-records.ts';
import { RevocationNotRecordedError, revokeAccessKey } from './key-revocation.ts';
import { cancelledLabels, creatorRoleStillMintsCheck } from './membership-changes.ts';
import { resolveMembership } from './org-membership.ts';
import { ResponseBuilder } from './response-builder.ts';
import type { ServiceOrchestrator } from './service-orchestrator.ts';

/**
 * The half of a mint that happens after the vendor has answered.
 *
 * Two handlers mint an S3 access key — `create-access-key` and
 * `rotate-access-key` — and from the moment the vendor returns a credential
 * they face the same problem: land its row or take it back, and never leave a
 * live credential that nothing local records. The ordering rules that solve it
 * are exact, and two copies of them is two things to keep right.
 *
 * The sibling of `key-revocation.ts`, which owns the same question on the way
 * out. What stays in the handlers is what genuinely differs: what they mint,
 * what they do about a duplicate name, and what they refuse before starting.
 */

/** The credential the vendor handed back, and where it lives. */
export interface MintedKey {
  /** The orchestrator's id for the key, which is what `deleteAccessKey` takes. */
  keyId: string;
  accessKeyId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

/** Who the creator-authority cap was evaluated for, and the key it admitted. */
export interface KeyMinter {
  orgId: string;
  userId: string;
  /** The permissions the key would carry. */
  key: AccessKeyPermissions;
}

/**
 * Whether the key's row landed. When it did not, the credential is still live
 * at the vendor and the caller has to hand it back.
 *
 * The two refusals mean different things to whoever asked. `minter_role_changed`
 * is the creator-authority `ConditionCheck` refusing, which no retry gets past;
 * `write_conflict` is DynamoDB refusing the whole transaction over contention
 * on the mint sequence, which every mint for this member writes and every
 * narrowing of their role asserts (`access-key-mint-seq.ts`), and which a retry
 * clears. One answer for both would send a demoted caller round a loop that
 * cannot end.
 */
export type MintRecord =
  | { recorded: true }
  | { recorded: false; reason: 'minter_role_changed' | 'write_conflict' };

/**
 * Write the key's row and the mint's completion event as one transaction, so
 * the record of a live credential cannot be the half that fails.
 *
 * A row the minter's role no longer covers does not land, and the intent stays
 * open: the caller takes the credential back with {@link discardUnrecordedKey},
 * which is what closes it.
 */
export async function recordMintedKey({
  row,
  mint,
  minter,
  recovered,
  extraDetails,
}: {
  row: AccessKeyRecord;
  mint: AuditCorrelation<'key.created'>;
  minter: KeyMinter;
  /** The credential existed at the vendor already and this write recovered its row. */
  recovered?: true;
  /** Anything the completion records beyond the key's own id suffix. */
  extraDetails?: Record<string, string>;
}): Promise<MintRecord> {
  try {
    await mint.complete({
      outcome: 'succeeded',
      details: {
        // The id the console shows, by its last characters only.
        keyIdSuffix: auditKeyIdSuffix('s3', row.accessKeyId),
        ...(recovered ? { recovered } : {}),
        ...extraDetails,
      },
      // The cap ran against a role read before the vendor call, so the row only
      // lands if the role on file could still grant the key. The sequence bump
      // rides the same transaction, which is what lets a narrowing notice a row
      // that landed after its listing — and what keeps a refused mint from
      // advancing it.
      items: [
        creatorRoleStillMintsCheck(minter),
        accessKeyMintSeqItem(minter),
        { Put: { TableName: Resource.UserInfoTable.name, Item: marshall(row) } },
      ],
    });
    return { recorded: true };
  } catch (err) {
    // The role check is item 0; `commitAudited` appends the audit Put last. The
    // unconditioned bump never cancels, but it holds a position, so it holds a
    // label.
    if (cancelledLabels(err, ['minterRole', 'mintSeq', 'keyRow']).includes('minterRole')) {
      return { recorded: false, reason: 'minter_role_changed' };
    }
    // A cancellation with no condition of ours in it is contention on the
    // sequence row: a second mint for this member, or the narrowing that asserts
    // it. Nothing landed, so the credential goes back rather than outliving the
    // request as an orphan nothing local records. Anything else is rethrown — a
    // timeout may have committed, and discarding a recorded key is worse.
    if (err instanceof TransactionCanceledException) {
      return { recorded: false, reason: 'write_conflict' };
    }
    throw err;
  }
}

/**
 * The row did not land, so the credential goes back.
 *
 * It is deleted here rather than left for the non-conforming-key review: the
 * secret has not been returned to anybody.
 *
 * The credential goes before the correlation closes. Closing first is
 * fail-closed and can throw, and a process that stops there leaves a live key at
 * the vendor with no local row and no record of it. A dangling intent is the
 * better failure: it is visible, and an orphan credential is not.
 *
 * When the delete fails too, the completion says so: `failed` alone would read
 * as a mint that came to nothing.
 */
export async function discardUnrecordedKey({
  minted,
  mint,
  minter,
  handler,
}: {
  minted: MintedKey;
  mint: AuditCorrelation<'key.created'>;
  minter: Pick<KeyMinter, 'orgId' | 'userId'>;
  /** The handler's name, for the log line an operator greps for. */
  handler: string;
}): Promise<void> {
  let cleanupFailed = false;
  try {
    await minted.orchestrator.deleteAccessKey(minted.tenantId, minted.keyId);
  } catch (err) {
    cleanupFailed = true;
    console.error(`[${handler}] Could not discard a key whose row never landed`, {
      orgId: minter.orgId,
      userId: minter.userId,
      keyIdSuffix: auditKeyIdSuffix('s3', minted.accessKeyId),
      error: err,
    });
  }
  await mint.complete({
    outcome: 'failed',
    ...(cleanupFailed ? { details: { cleanupFailed } } : {}),
  });
}

/**
 * Both halves this time: the row landed, unlike {@link discardUnrecordedKey}'s
 * path. Through `revokeAccessKey` so the removal is audited like any other, and
 * so the row delete rides its completion rather than being a second write
 * nobody records.
 */
export async function discardRecordedKey({
  minted,
  minter,
  actor,
  handler,
}: {
  minted: MintedKey;
  minter: Pick<KeyMinter, 'orgId' | 'userId'>;
  actor: AuditActor;
  handler: string;
}): Promise<void> {
  try {
    await revokeAccessKey({ orgId: minter.orgId, ...minted, actor, reason: 'stale_role_at_mint' });
  } catch (err) {
    // Left for the operator rather than retried: a second delete against a
    // vendor that just refused one is not for a request path. A
    // `RevocationNotRecordedError` is a dead credential with a stale row;
    // anything else may still be live.
    console.error(
      err instanceof RevocationNotRecordedError
        ? `[${handler}] Discarded a key whose minter was demoted, but its row survives`
        : `[${handler}] Could not discard a key whose minter was demoted`,
      {
        orgId: minter.orgId,
        userId: minter.userId,
        keyIdSuffix: auditKeyIdSuffix('s3', minted.accessKeyId),
        error: err,
      },
    );
  }
}

/**
 * The same narrowing, found one moment later.
 *
 * The row's own `ConditionCheck` refuses a key whose minter was demoted before
 * it landed. It cannot refuse one that landed first: at that instant the minter
 * did still hold a role that covers the key, so the condition is satisfied and
 * correctly so. The key only becomes excessive when the role write follows, and
 * by then the narrowing's listing has already been taken without it.
 *
 * So the mint looks once more, being the only request holding the credential. A
 * demotion landing after this read is the narrowing's to catch
 * (`access-key-mint-seq.ts`).
 *
 * The key, not the role: a promotion mid-mint strands nothing, a demotion that
 * still grants what the key holds is no reason to take it away, and an absent
 * membership grants nothing at all.
 */
export async function keyExceedsCurrentRole({ orgId, userId, key }: KeyMinter): Promise<boolean> {
  const current = (await resolveMembership(orgId, userId))?.role ?? NO_ROLE;
  return !canRetainAccessKey(current, key).retained;
}

/**
 * The attributes a key row carries only when it was asked for them, so an
 * absent one reads as "not requested" rather than as an empty list.
 *
 * Every one is optional on the row and `marshall` throws on an undefined map
 * value, so leaving one out is not tidiness — writing it as undefined throws
 * after the vendor has already minted the credential.
 */
export function optionalKeyAttributes(
  key: Pick<AccessKeyRecord, 'granularPermissions' | 'bucketScope' | 'buckets'> & {
    /** `null` as well as absent, which is what the create schema produces for "never". */
    expiresAt?: string | null;
  },
): Pick<AccessKeyRecord, 'granularPermissions' | 'bucketScope' | 'buckets' | 'expiresAt'> {
  return {
    ...(key.granularPermissions?.length ? { granularPermissions: key.granularPermissions } : {}),
    ...(key.bucketScope ? { bucketScope: key.bucketScope } : {}),
    ...(key.buckets ? { buckets: key.buckets } : {}),
    ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
  };
}

/** The mint lost a race with another write to this member's keys. */
export function mintConflictResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'Another change to this member’s keys was in flight — try again.',
    })
    .build();
}

/** The answer when the minter's role moved: try again under the one they hold now. */
export function roleChangedResponse(
  verb: 'created' | 'rotated',
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: `Your role in this organization changed while the key was being ${verb}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

/**
 * The creator-authority cap refusing, naming what it refused.
 *
 * The denial names the offending permissions, because "your role does not
 * permit this key" against a form with eight checkboxes is not actionable.
 */
export function exceedsRoleResponse(
  excess: ExcessKeyPermission[],
): APIGatewayProxyStructuredResultV2 {
  const named = excess.map(({ keyPermission }) => keyPermission).join(', ');
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `A key cannot carry more than you do. Your role does not permit: ${named}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}
