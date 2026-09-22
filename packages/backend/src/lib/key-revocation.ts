import { marshall } from '@aws-sdk/util-dynamodb';
import { auditKeyIdSuffix } from '@filone/shared';
import type { AuditActor, RevocationTrigger } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, twoPhaseAudit } from './audit.ts';
import { AccessKeyKeys } from './dynamo-records.ts';
import type { ServiceOrchestrator } from './service-orchestrator.ts';

export interface RevokeAccessKeyArgs {
  orgId: string;
  /** The orchestrator's id for the key, which is what `deleteAccessKey` takes. */
  keyId: string;
  /** What the console lists. Absent only on rows written before it was stored. */
  accessKeyId?: string | undefined;
  keyName?: string | undefined;
  /** The storage network the credential is revoked at. */
  orchestratorId: string;
  orchestrator: Pick<ServiceOrchestrator, 'deleteAccessKey'>;
  tenantId: string;
  /** Who asked. On a role change this is the admin, never the key's holder. */
  actor: AuditActor;
  /** What took the key. Required, so no revocation goes unexplained. */
  reason: RevocationTrigger;
}

/**
 * The vendor deleted the credential and the write that records it did not land.
 *
 * The key is dead either way, which is the opposite of what a bare rejection
 * from {@link revokeAccessKey} means, so callers that report what happened have
 * to be able to tell the two apart. What survives is the row: it lists a
 * credential that no longer exists, until somebody deletes it.
 */
export class RevocationNotRecordedError extends Error {
  readonly keyId: string;
  constructor(keyId: string, options?: { cause?: unknown }) {
    super(`Access key ${keyId} was deleted at the vendor, but the record did not land.`, options);
    this.name = 'RevocationNotRecordedError';
    this.keyId = keyId;
  }
}

/**
 * Revoke one key at its orchestrator and delete the row that lists it.
 *
 * Revocation happens at the vendor first and cannot join a local transaction,
 * so it gets the same intent/completion pair a mint does: an intent that never
 * completes says a credential was revoked at the vendor while its local row may
 * still be listed.
 *
 * Best-effort, unlike a mint: an AuditTable outage must never be the reason a
 * leaked key stays live, so a failed intent is logged and counted and the
 * revocation goes ahead. The key id is known up front, so both halves are filed
 * under the key.
 *
 * The caller decides who may do this. A member revoking their own key is
 * checked against `keyScope`; a revocation pass on a role change is authorized
 * by the role change itself.
 */
export async function revokeAccessKey({
  orgId,
  keyId,
  accessKeyId,
  keyName,
  orchestratorId,
  orchestrator,
  tenantId,
  actor,
  reason,
}: RevokeAccessKeyArgs): Promise<void> {
  const revocation = await twoPhaseAudit({
    type: 'key.deleted',
    mode: 'best-effort',
    actor,
    orgId,
    // The access key id, which is what the console lists and what the details
    // record four characters of — `keyId` is the orchestrator's own id for the
    // row and four characters of it match nothing an operator can see. A row
    // written before the id was stored falls back to it anyway.
    subject: AuditSubjects.key('s3', accessKeyId ?? keyId),
    details: {
      keyKind: 's3',
      orchestratorId,
      ...(keyName ? { keyName } : {}),
      ...(accessKeyId ? { keyIdSuffix: auditKeyIdSuffix('s3', accessKeyId) } : {}),
      reason,
    },
  });

  try {
    await orchestrator.deleteAccessKey(tenantId, keyId);
  } catch (err) {
    await revocation.complete({ outcome: 'failed' });
    throw err;
  }

  try {
    await revocation.complete({
      outcome: 'succeeded',
      items: [
        {
          Delete: {
            TableName: Resource.UserInfoTable.name,
            Key: marshall({ pk: AccessKeyKeys.orgPk(orgId), sk: AccessKeyKeys.keySk(keyId) }),
          },
        },
      ],
    });
  } catch (err) {
    throw new RevocationNotRecordedError(keyId, { cause: err });
  }
}

/**
 * Revoke a key and say whether it went, instead of raising when it did not.
 *
 * For the caller who is holding something the failure must not cost. A rotation
 * has already minted the replacement and its secret exists only in that
 * request's response, so throwing here would take a credential nobody can
 * recover to save the caller from a key they can delete from the list
 * themselves. The answer is reported and the request completes.
 *
 * {@link RevocationNotRecordedError} is the other way round: the credential is
 * dead and its row survives. It is revoked, so the answer is yes, and the stale
 * row is the operator's to clear.
 */
export async function revokeAndReport(args: RevokeAccessKeyArgs): Promise<boolean> {
  try {
    await revokeAccessKey(args);
    return true;
  } catch (err) {
    const notRecorded = err instanceof RevocationNotRecordedError;
    console.error(
      notRecorded
        ? '[key-revocation] Revoked a key, but its row survives'
        : '[key-revocation] Could not revoke a key',
      {
        orgId: args.orgId,
        reason: args.reason,
        ...(args.accessKeyId ? { keyIdSuffix: auditKeyIdSuffix('s3', args.accessKeyId) } : {}),
        error: err,
      },
    );
    return notRecorded;
  }
}
