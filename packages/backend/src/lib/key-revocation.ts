import { marshall } from '@aws-sdk/util-dynamodb';
import { auditKeyIdSuffix } from '@filone/shared';
import type { AuditActor, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, twoPhaseAudit } from './audit.js';
import { AccessKeyKeys } from './dynamo-records.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

/** Why a key was revoked, when something other than its owner asked for it. */
export type KeyRevocationReason = 'role_narrowing' | 'member_removed';

export interface RevokeAccessKeyArgs {
  orgId: string;
  /** The orchestrator's id for the key, which is what `deleteAccessKey` takes. */
  keyId: string;
  /** What the console lists. Absent only on rows written before it was stored. */
  accessKeyId?: string | undefined;
  keyName?: string | undefined;
  region: S3Region;
  orchestrator: Pick<ServiceOrchestrator, 'deleteAccessKey'>;
  tenantId: string;
  /** Who asked. On a role change this is the admin, never the key's holder. */
  actor: AuditActor;
  reason?: KeyRevocationReason | undefined;
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
  region,
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
      region,
      ...(keyName ? { keyName } : {}),
      ...(accessKeyId ? { keyIdSuffix: auditKeyIdSuffix('s3', accessKeyId) } : {}),
      ...(reason ? { reason } : {}),
    },
  });

  try {
    await orchestrator.deleteAccessKey(tenantId, keyId);
  } catch (err) {
    await revocation.complete({ outcome: 'failed' });
    throw err;
  }

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
}
