// Keeping the roster statements on every bucket policy in step with the
// organization's Owners and Admins, on each region serving the `iam` access
// model (the bucket-access ADR, "The console grants Owners and Admins every
// bucket explicitly").
//
// The storage system knows only statements, so an Owner or Admin reaches every
// bucket only because the console named them on every bucket's policy. A
// promotion into or demotion out of those roles rewrites one policy per bucket
// in the region, and a member's removal takes their principal, keys, and every
// statement naming them in one call. Neither can be atomic across buckets, so
// each write is idempotent, the report says which buckets took it, and the
// retry is the same request.

import pRetry from 'p-retry';
import { OrgRole, replaceRosterStatements } from '@filone/shared';
import type { AuditActor, BucketPolicy, PolicySyncReport, Roster, S3Region } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit } from './audit.ts';
import { PolicyPreconditionFailedError } from './errors.ts';
import type { StoredBucketPolicy } from './bucket-policy-orchestrator.ts';
import { listMembers } from './org-membership.ts';
import type { OrgProfileItem } from './org-profile.ts';
import { removeRegisteredPrincipal } from './org-profile.ts';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import { supportsBucketPolicies, type ServiceOrchestrator } from './service-orchestrator.ts';

/**
 * The roster as the storage system should see it after a role change. Read
 * from the membership rows, with the changing member placed at the role they
 * are moving to, so the same function serves a demotion written before the role
 * row and a promotion written after it.
 */
export async function getRosterAfterChange(
  orgId: string,
  change?: { userId: string; role: OrgRole },
): Promise<Roster> {
  const members = (await listMembers(orgId))
    .filter((member) => member.userId !== change?.userId)
    .map((member) => ({ userId: member.userId, role: member.role }));
  if (change) members.push(change);
  return {
    owners: members.filter((m) => m.role === OrgRole.Owner).map((m) => m.userId),
    admins: members.filter((m) => m.role === OrgRole.Admin).map((m) => m.userId),
  };
}

/** Whether a role is one the console names on every bucket's policy. */
export function isRosterRole(role: OrgRole): boolean {
  return role === OrgRole.Owner || role === OrgRole.Admin;
}

/** The ready `iam` orchestrators for this org, with the tenant each resolved. */
function getReadyIamOrchestrators(
  orgProfile: OrgProfileItem | undefined,
): Array<{ orchestrator: ServiceOrchestrator; tenantId: string }> {
  return getAvailableOrchestrators().flatMap((orchestrator) => {
    if (!supportsBucketPolicies(orchestrator)) return [];
    const tenantId = orchestrator.isTenantReady(orgProfile);
    return tenantId ? [{ orchestrator, tenantId }] : [];
  });
}

/**
 * Rewrite the roster statements on every bucket policy in every ready `iam`
 * region, keeping each policy's other statements. Never throws: a bucket whose
 * write failed is named in the region's report, and the caller decides what
 * that means for the change it is making.
 */
export async function syncRosterStatements({
  orgId,
  orgProfile,
  roster,
  actor,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  roster: Roster;
  actor: AuditActor;
}): Promise<PolicySyncReport[]> {
  const regions = getReadyIamOrchestrators(orgProfile);
  return Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      syncRosterStatementsInRegion({ orgId, orchestrator, tenantId, roster, actor }),
    ),
  );
}

async function syncRosterStatementsInRegion({
  orgId,
  orchestrator,
  tenantId,
  roster,
  actor,
}: {
  orgId: string;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  roster: Roster;
  actor: AuditActor;
}): Promise<PolicySyncReport> {
  const report: PolicySyncReport = {
    region: orchestrator.region,
    bucketsUpdated: 0,
    bucketsFailed: [],
    bucketListFailed: false,
  };
  let buckets: string[];
  try {
    // Every member a statement will name has to exist as a principal first.
    for (const userId of [...roster.owners, ...roster.admins]) {
      await orchestrator.syncMember(tenantId, userId);
    }
    buckets = (await orchestrator.listBuckets(tenantId)).map((bucket) => bucket.bucketName);
  } catch (err) {
    console.error('[iam-policy-fanout] Could not list the region before rewriting its policies', {
      orgId,
      region: orchestrator.region,
      error: err,
    });
    return { ...report, bucketListFailed: true };
  }

  for (const bucketName of buckets) {
    try {
      await replaceRosterStatementsOnBucket({
        orgId,
        orchestrator,
        tenantId,
        bucketName,
        roster,
        actor,
      });
      report.bucketsUpdated += 1;
    } catch (err) {
      console.error('[iam-policy-fanout] Could not rewrite a bucket policy', {
        orgId,
        region: orchestrator.region,
        bucketName,
        error: err,
      });
      report.bucketsFailed.push(bucketName);
    }
  }
  return report;
}

/**
 * One bucket: read, replace the roster statements, write under the ETag read,
 * or delete the policy when no statement is left. A policy already carrying
 * the roster is not written again: each write makes the storage system revoke
 * and reissue the delegations of every key bound to a principal it changes, and
 * a bucket reached twice would pay for that a second time.
 */
async function replaceRosterStatementsOnBucket({
  orgId,
  orchestrator,
  tenantId,
  bucketName,
  roster,
  actor,
}: {
  orgId: string;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  bucketName: string;
  roster: Roster;
  actor: AuditActor;
}): Promise<void> {
  const { region } = orchestrator;
  await pRetry(
    async () => {
      const current = await orchestrator.getBucketPolicy(tenantId, bucketName);
      const next = replaceRosterStatements(current?.policy ?? null, roster);
      if (JSON.stringify(current?.policy ?? null) === JSON.stringify(next)) return;
      await writeBucketPolicyWithAudit({ orgId, region, bucketName, actor, current, next }, () =>
        next
          ? orchestrator.putBucketPolicy(
              tenantId,
              bucketName,
              next,
              current ? { ifMatch: current.etag } : { ifNoneMatch: '*' },
            )
          : orchestrator.deleteBucketPolicy(tenantId, bucketName, { ifMatch: current!.etag }),
      );
    },
    // A stale ETag is another writer landing first; the read-modify-write runs
    // again on what is there now. Bounded, so a bucket under constant edit fails
    // the report rather than the request.
    {
      retries: 3,
      minTimeout: 50,
      maxTimeout: 500,
      shouldRetry: ({ error }) => error instanceof PolicyPreconditionFailedError,
    },
  );
}

/**
 * The intent-and-completion pair around one rewritten policy, with the
 * role-change trigger. Best-effort: the role change is the recorded act, and
 * an audit outage must not stop its consequences reaching the storage system.
 */
async function writeBucketPolicyWithAudit(
  {
    orgId,
    region,
    bucketName,
    actor,
    current,
    next,
  }: {
    orgId: string;
    region: S3Region;
    bucketName: string;
    actor: AuditActor;
    current: StoredBucketPolicy | null;
    next: BucketPolicy | null;
  },
  write: () => Promise<unknown>,
): Promise<void> {
  const auditEventType = !next
    ? 'bucket_policy.deleted'
    : current
      ? 'bucket_policy.updated'
      : 'bucket_policy.created';
  const audit = await twoPhaseAudit({
    type: auditEventType,
    mode: 'best-effort',
    actor,
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'role_changed' },
  });
  try {
    await write();
  } catch (err) {
    await audit.complete({ outcome: 'failed' });
    throw err;
  }
  await audit.complete({
    outcome: 'succeeded',
    ...(next ? { details: { statements: next.Statement.length } } : {}),
  });
}

/**
 * Remove a member's principal from every ready `iam` region: their keys and
 * every statement naming them go with it at the storage system. Answers the
 * regions reached and the ones that refused; the caller decides whether the
 * membership change proceeds.
 */
export async function removeMemberPrincipalFromIamRegions({
  orgId,
  orgProfile,
  userId,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  userId: string;
}): Promise<{ removed: S3Region[]; failed: S3Region[] }> {
  const regions = getReadyIamOrchestrators(orgProfile);
  // The member's id leaves the PROFILE row's `${id}Principals` set as part of
  // the region's removal: an id left behind would make
  // {@link registerMemberPrincipals} skip a re-invited member, so a failed
  // update refuses the region and the retry runs both steps again.
  const outcomes = await Promise.all(
    regions.map(async ({ orchestrator, tenantId }) => {
      const { region } = orchestrator;
      try {
        await orchestrator.removeMember(tenantId, userId);
        await removeRegisteredPrincipal(orgId, orchestrator.id, userId);
        return { region, ok: true };
      } catch (error) {
        console.error('[iam-policy-fanout] Could not remove a principal', {
          region,
          userId,
          error,
        });
        return { region, ok: false };
      }
    }),
  );
  const getRegionsWithOutcome = (ok: boolean) =>
    outcomes.filter((o) => o.ok === ok).map((o) => o.region);
  return { removed: getRegionsWithOutcome(true), failed: getRegionsWithOutcome(false) };
}
