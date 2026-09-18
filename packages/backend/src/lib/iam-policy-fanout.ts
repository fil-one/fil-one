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
import { OrgRole, withRosterStatements } from '@filone/shared';
import type { AuditActor, BucketPolicy, PolicySyncReport, S3Region } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit } from './audit.ts';
import { PolicyPreconditionFailedError } from './errors.ts';
import type { StoredBucketPolicy } from './iam-orchestrator.ts';
import { listMembers } from './org-membership.ts';
import type { OrgProfileItem } from './org-profile.ts';
import { removeRegisteredPrincipal } from './org-profile.ts';
import { deleteMemberS3Credentials } from './s3-credentials.ts';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import type { IamOrchestrator } from './service-orchestrator.ts';

/** The org's Owners and Admins by user id, as the roster statements name them. */
export interface Roster {
  owners: string[];
  admins: string[];
}

/**
 * A stale ETag between the read and the write is another writer landing first;
 * the read-modify-write simply runs again on what is there now. Bounded, so a
 * bucket under constant edit fails the report rather than the request.
 */
const ROSTER_WRITE_RETRY = { retries: 3, minTimeout: 50, maxTimeout: 500 } as const;

/**
 * The roster as the storage system should see it after a role change. Read
 * from the membership rows, with the changing member placed at the role they
 * are moving to, so the same function serves a demotion written before the role
 * row and a promotion written after it.
 */
export async function rosterAfterChange(
  orgId: string,
  change?: { userId: string; role: OrgRole | null },
): Promise<Roster> {
  const members = (await listMembers(orgId))
    .filter((member) => member.userId !== change?.userId)
    .map((member) => ({ userId: member.userId, role: member.role as string }));
  if (change?.role) members.push({ userId: change.userId, role: change.role });
  return {
    owners: members.filter((m) => m.role === OrgRole.Owner).map((m) => m.userId),
    admins: members.filter((m) => m.role === OrgRole.Admin).map((m) => m.userId),
  };
}

/** Whether a role is one the console names on every bucket's policy. */
export function isRosterRole(role: string): boolean {
  return role === OrgRole.Owner || role === OrgRole.Admin;
}

/** The ready `iam` orchestrators for this org, with the tenant each resolved. */
function readyIamRegions(
  orgProfile: OrgProfileItem | undefined,
): Array<{ orchestrator: IamOrchestrator; tenantId: string }> {
  return getAvailableOrchestrators().flatMap((orchestrator) => {
    if (orchestrator.accessModel !== 'iam') return [];
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
  const regions = readyIamRegions(orgProfile);
  return Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      syncRegion({ orgId, orchestrator, tenantId, roster, actor }),
    ),
  );
}

async function syncRegion({
  orgId,
  orchestrator,
  tenantId,
  roster,
  actor,
}: {
  orgId: string;
  orchestrator: IamOrchestrator;
  tenantId: string;
  roster: Roster;
  actor: AuditActor;
}): Promise<PolicySyncReport> {
  const report: PolicySyncReport = {
    region: orchestrator.region,
    bucketsReached: 0,
    bucketsFailed: [],
  };
  let buckets: string[];
  try {
    // Every member a statement will name has to exist as a principal first.
    for (const userId of [...roster.owners, ...roster.admins]) {
      await orchestrator.iam.syncMember(tenantId, userId);
    }
    buckets = (await orchestrator.listBuckets(tenantId)).map((bucket) => bucket.bucketName);
  } catch (err) {
    console.error('[iam-policy-fanout] Could not list the region before rewriting its policies', {
      orgId,
      region: orchestrator.region,
      error: err,
    });
    return { ...report, bucketsFailed: ['*'] };
  }

  for (const bucketName of buckets) {
    try {
      await writeRosterStatements({ orgId, orchestrator, tenantId, bucketName, roster, actor });
      report.bucketsReached += 1;
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
 * One bucket: read, replace the roster statements, write under the ETag read.
 * A policy already carrying the roster is left alone, so a change that reaches
 * a bucket twice costs no second revocation round at the storage system.
 */
async function writeRosterStatements({
  orgId,
  orchestrator,
  tenantId,
  bucketName,
  roster,
  actor,
}: {
  orgId: string;
  orchestrator: IamOrchestrator;
  tenantId: string;
  bucketName: string;
  roster: Roster;
  actor: AuditActor;
}): Promise<void> {
  const { iam, region } = orchestrator;
  await pRetry(
    async () => {
      const current = await iam.getBucketPolicy(tenantId, bucketName);
      const next = withRosterStatements(current?.policy ?? null, roster);
      if (unchanged(current, next)) return;
      await auditedWrite({ orgId, region, bucketName, actor, current, next }, () =>
        next
          ? iam.putBucketPolicy(
              tenantId,
              bucketName,
              next,
              current ? { ifMatch: current.etag } : { ifNoneMatch: '*' },
            )
          : iam.deleteBucketPolicy(tenantId, bucketName, { ifMatch: current!.etag }),
      );
    },
    {
      ...ROSTER_WRITE_RETRY,
      shouldRetry: ({ error }) => error instanceof PolicyPreconditionFailedError,
    },
  );
}

function unchanged(current: StoredBucketPolicy | null, next: BucketPolicy | null): boolean {
  if (!current && !next) return true;
  return Boolean(current && next) && JSON.stringify(current!.policy) === JSON.stringify(next);
}

/**
 * The intent-and-completion pair around one rewritten policy, with `trigger:
 * role_change`. Best-effort: the role change is the recorded act, and an audit
 * outage must not stop its consequences reaching the storage system.
 */
async function auditedWrite(
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
  const type = !next
    ? 'bucket_policy.deleted'
    : current
      ? 'bucket_policy.updated'
      : 'bucket_policy.created';
  const audit = await twoPhaseAudit({
    type,
    mode: 'best-effort',
    actor,
    orgId,
    subject: AuditSubjects.bucket(region, bucketName),
    details: { region, bucketName, trigger: 'role_change' },
  });
  try {
    await write();
  } catch (err) {
    await audit.complete({ outcome: 'failed' });
    throw err;
  }
  await audit.complete({
    outcome: 'succeeded',
    ...(next ? { details: { statements: next.statement.length } } : {}),
  });
}

/**
 * Remove a member's principal from every ready `iam` region: their keys and
 * every statement naming them go with it at the storage system. Answers the
 * regions reached and the ones that refused; the caller decides whether the
 * membership change proceeds.
 */
export async function removeMemberPrincipals({
  orgId,
  orgProfile,
  userId,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  userId: string;
}): Promise<{ removed: S3Region[]; failed: S3Region[] }> {
  const regions = readyIamRegions(orgProfile);
  const outcomes = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) => orchestrator.iam.removeMember(tenantId, userId)),
  );
  const removed: S3Region[] = [];
  const failed: S3Region[] = [];
  // Keeps the PROFILE set in step with the orchestrator: an id left behind
  // would make a later ensureTenantReady treat the member as registered.
  const pruned: Array<Promise<unknown>> = [];
  outcomes.forEach((outcome, index) => {
    const { region, id } = regions[index]!.orchestrator;
    if (outcome.status === 'fulfilled') {
      removed.push(region);
      pruned.push(
        removeRegisteredPrincipal(orgId, id, userId).catch((error: unknown) => {
          // A stale entry only costs a skipped re-registration for a member who
          // is no longer in the org, so the removal itself still stands.
          console.error('[iam-policy-fanout] Could not prune a registered principal', {
            region,
            userId,
            error,
          });
        }),
        // The console's own key for this member dies with the principal. Only
        // for a region that removed it: one that refused still has the key live.
        deleteMemberS3Credentials({
          orchestratorId: id,
          stage: process.env.FILONE_STAGE!,
          tenantId: regions[index]!.tenantId,
          userId,
        }).catch((error: unknown) => {
          // A parameter left behind costs a signing failure for someone no
          // longer in the org, and the next mint's name collision repairs it.
          console.error('[iam-policy-fanout] Could not delete a member credential', {
            region,
            userId,
            error,
          });
        }),
      );
      return;
    }
    console.error('[iam-policy-fanout] Could not remove a principal', {
      region,
      userId,
      error: outcome.reason,
    });
    failed.push(region);
  });
  await Promise.all(pruned);
  return { removed, failed };
}
