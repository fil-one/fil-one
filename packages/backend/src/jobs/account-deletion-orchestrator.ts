import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { clearOrgDeletionGuard } from '../lib/deletion-guards.js';
import {
  sweepResurrectedOrgs,
  type ResurrectedOrg,
  type SweepCandidate,
} from '../lib/deletion-resurrection-sweep.js';
import {
  failedRedactionCustomerIds,
  OrgDeletionStatus,
  pendingRedactionCustomerIds,
  type OrgDeletionRecord,
} from '../lib/dynamo-records.js';
import { reportMetric } from '../lib/metrics.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import type { AccountDeletionWorkerPayload } from './account-deletion-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

/**
 * Ignore records the worker touched more recently than this — it's live.
 * Must exceed the worker's 900s Lambda timeout: the worker bumps `updatedAt`
 * once per pass (bumpAttemptCount), so a window shorter than a pass could
 * re-invoke against a still-running worker. 60 minutes leaves generous room
 * for the worker's own async retries too.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
/**
 * Past this many worker attempts the record counts as stuck (alerting gauge).
 *
 * Above one confirm-time invoke chain on purpose. The worker bumps
 * `attemptCount` once per pass, and a single failing invoke from the confirm
 * handler is already three passes — the initial one plus Lambda's two async
 * retries — so a threshold of 3 paged before this cron had ever attempted a
 * re-drive. At 4, the gauge means "the automated rescue has also failed at least
 * once", which is the condition an operator is actually needed for.
 */
const STUCK_ATTEMPT_THRESHOLD = 4;

/**
 * How long after a DELETION record last advanced the resurrection sweep keeps
 * checking that org. Measured from `updatedAt`, which `markDone` stamps at
 * completion and every resweep re-stamps — so an org that keeps resurrecting
 * keeps being watched, while a clean one ages out.
 *
 * Bounded rather than "every DONE record ever": DELETION records are retained
 * indefinitely as audit records, so an unbounded sweep grows without limit
 * inside a 300s Lambda. The writers that can resurrect an org fire on user or
 * webhook activity, and the longest-delayed of them are Stripe's webhook
 * retries (days, not hours) and the daily usage-reporting worker; a week
 * covers both with margin and gives every record 14 sweeps at the 12-hourly
 * cadence. A row appearing after that means a fence gap wide enough that the
 * fix belongs in the writer, not in a longer sweep.
 *
 * The window bounds the search for RESURRECTED ROWS. It deliberately does not
 * bound a record's own unfinished Stripe redaction: that is a known, finite,
 * per-record obligation with a known end state, and ageing it out would abandon
 * a customer's PII in Stripe. See {@link sweepCandidates}.
 */
const RESWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Wall-clock the sweep's per-org partition probes may consume, measured from
 * the top of the handler. The 300s Lambda has to fit the scan, the rescue
 * re-drives, the sweep and the unwedge; this stops the one part that scales
 * with the window from eating the rest. Candidates past it are counted in the
 * summary log and stay in the window for the next run.
 */
const SWEEP_BUDGET_MS = 150 * 1000;

/**
 * Rescues account deletions whose worker died mid-teardown (FIL-112): scans
 * for DELETION records that are not DONE and have not advanced recently,
 * re-invokes the worker for each, and emits StuckAccountDeletionCount so
 * repeatedly-failing teardowns surface in Grafana. The user was already told
 * deletion succeeded — this cron is what makes that promise eventually true.
 *
 * That rescue path runs FIRST — gauge, then re-drives — so the cheapest and most
 * alert-critical output cannot be lost to anything below it.
 *
 * Next it clears the org-profile `deleting` guard for any org that carries it
 * with no DELETION record at all — see {@link clearStaleDeletionGuards}. This runs
 * before the sweep so those unwedges get first claim on the shared budget; its
 * DONE-guarded orgs are merged into the re-drive list either way.
 *
 * Then it sweeps recently-DONE records for rows that came back after the purge
 * (billing, org partition, RAG index, RAG key-hash lookups) plus any record
 * carrying a resurrected Stripe customer whose Redaction Job has not settled —
 * see lib/deletion-resurrection-sweep.ts — and re-invokes the worker with
 * `resweep`, which is what lets it get past the DONE early-return in
 * `runAccountDeletion` and actually finish them.
 */
export async function handler(): Promise<void> {
  const workerFunctionName = process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!;
  const now = Date.now();

  // If the scan itself fails, the handler throws here and NO metric is
  // emitted this run — deliberate: an absent gauge alerts differently from a
  // zero, and the cron's own error metric covers the scan failure.
  const scanned = await scanUserInfoTable();
  const incomplete = scanned.deletions.filter((r) => r.status !== OrgDeletionStatus.Done);
  const done = scanned.deletions.filter((r) => r.status === OrgDeletionStatus.Done);

  const stale = incomplete.filter((record) => isStale(record, now));
  const stuck = incomplete.filter(
    (record) => (record.attemptCount ?? 0) >= STUCK_ATTEMPT_THRESHOLD,
  );

  // Gauge first: the cheapest, most alert-critical output runs before anything
  // that can consume budget or throw, so a regression in the sweep's bounds can
  // never cost the gauge.
  emitGauge('StuckAccountDeletionCount', stuck.length);

  let reinvoked = 0;
  let failed = 0;
  for (const record of stale) {
    const orgId = record.pk.slice('ORG#'.length);
    if (await invokeWorker(workerFunctionName, orgId)) reinvoked += 1;
    else failed += 1;
  }

  const deadline = now + SWEEP_BUDGET_MS;
  const statusByOrgId = new Map(
    scanned.deletions.map((record) => [record.pk.slice('ORG#'.length), record.status]),
  );
  const guards = await clearStaleDeletionGuards(scanned.guardedOrgIds, statusByOrgId, deadline);

  const candidates = sweepCandidates(done, now);
  const swept = await sweepResurrectedOrgs({
    candidates,
    ragKeyHashOrgIds: scanned.ragKeyHashOrgIds,
    deadline,
  });
  const resurrected = mergeResurrected(swept.resurrected, guards.resweepOrgIds);

  emitGauge('ResurrectedAccountDeletionCount', resurrected.length);
  // Coverage lost to the budget, in orgs — the guard sweep and the org-partition
  // probe are the two per-org loops it can cut short. A log line is not
  // alertable in this repo (Grafana rules read the EMF MetricStream), and a
  // sweep that silently checks nothing looks exactly like a clean one.
  emitGauge('DeletionSweepSkippedCount', swept.skipped + guards.skipped);
  // The RagIndexerTable scan has no per-org granularity to skip: it either
  // completed or the `ragIndex` surface went unchecked for the whole run.
  emitGauge('DeletionSweepTruncatedCount', swept.ragIndexTruncated ? 1 : 0);
  // Redactions that ended terminally without erasing anything. The sweep
  // deliberately stops re-driving those (that is what makes it converge), so
  // this gauge is what stands in for the re-drive.
  const redactionFailed = reportFailedRedactions(done);
  emitGauge('DeletionRedactionFailedCount', redactionFailed);

  let reswept = 0;
  let resweepFailed = 0;
  for (const org of resurrected) {
    console.warn(
      '[account-deletion-orchestrator] Residue found after a completed teardown — re-driving. ' +
        'A row surface means a pre-fence leftover or a gap in the fences, since every writer ' +
        'behind those is fenced; `stripeRedaction` means an earlier resweep left a Redaction Job ' +
        'unfinished for a resurrected customer',
      {
        orgId: org.orgId,
        surfaces: org.surfaces,
        userIds: org.userIds,
        pendingRedactionCustomerIds: org.pendingRedactionCustomerIds,
      },
    );
    if (await invokeWorker(workerFunctionName, org.orgId, { resweep: true })) reswept += 1;
    else resweepFailed += 1;
  }

  // An org whose resweep could not even be INVOKED keeps its resurrected rows
  // until the next run, so this is a rescue-path failure, not bookkeeping.
  emitGauge('DeletionResweepFailedCount', resweepFailed);

  console.log('[account-deletion-orchestrator] Orchestration complete', {
    incomplete: incomplete.length,
    stale: stale.length,
    reinvoked,
    failed,
    stuck: stuck.length,
    candidates: candidates.length,
    sweepSkipped: swept.skipped,
    ragIndexTruncated: swept.ragIndexTruncated,
    guardSkipped: guards.skipped,
    resurrected: resurrected.length,
    reswept,
    resweepFailed,
    redactionFailed,
    unwedged: guards.unwedged,
  });
}

/**
 * Emits one gauge as its own EMF event. The isolation comes from emitting at
 * compute time — a later gauge that throws cannot retract one already written.
 */
function emitGauge(
  name:
    | 'StuckAccountDeletionCount'
    | 'ResurrectedAccountDeletionCount'
    | 'DeletionSweepSkippedCount'
    | 'DeletionSweepTruncatedCount'
    | 'DeletionResweepFailedCount'
    | 'DeletionRedactionFailedCount',
  value: number,
): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'FilOne', Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] },
      ],
    },
    [name]: value,
  });
}

/** Event-invokes the worker for one org, via the same path every re-drive uses. */
async function invokeWorker(
  workerFunctionName: string,
  orgId: string,
  opts: { resweep?: boolean } = {},
): Promise<boolean> {
  try {
    const payload: AccountDeletionWorkerPayload = {
      orgId,
      ...(opts.resweep ? { resweep: true } : {}),
    };
    await lambda.send(
      new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch (error) {
    console.error('[account-deletion-orchestrator] Failed to re-invoke worker', { orgId, error });
    return false;
  }
}

/**
 * DONE records to sweep: those still inside {@link RESWEEP_WINDOW_MS}, PLUS any
 * record — however old — whose resurrected Stripe customer still has no
 * terminal redaction status.
 *
 * The exemption is what makes a resweep's Stripe tail converge: it keys on the
 * record's own state, which survives the purge that erases every other surface —
 * see the `stripeRedaction` surface on `sweepResurrectedOrgs`
 * (lib/deletion-resurrection-sweep.ts). Ageing it out on a clock would put the PII
 * back beyond reach. Unbounded is safe here in a way an unbounded row sweep is not:
 * it costs no round trip, and the set is exactly the orgs a guard gap resurrected —
 * normally empty.
 */
function sweepCandidates(done: ScannedDeletion[], now: number): SweepCandidate[] {
  return done
    .map((record) => ({ record, pending: pendingRedactionCustomerIds(record) }))
    .filter(({ record, pending }) => pending.length > 0 || isInsideResweepWindow(record, now))
    .map(({ record, pending }) => ({
      orgId: record.pk.slice('ORG#'.length),
      userIds: (record.members ?? []).map((member) => member.userId).filter(Boolean),
      pendingRedactionCustomerIds: pending,
    }));
}

/** Unparseable `updatedAt` sweeps rather than skips, matching {@link isStale}. */
function isInsideResweepWindow(record: ScannedDeletion, now: number): boolean {
  const updatedAtMs = new Date(record.updatedAt).getTime();
  return Number.isNaN(updatedAtMs) || now - updatedAtMs <= RESWEEP_WINDOW_MS;
}

/**
 * Count — and name — the DONE records whose resurrected customer's Redaction
 * Job ended terminally WITHOUT erasing anything (`failed`/`canceled`).
 *
 * Terminal is what stops {@link sweepCandidates} re-driving the org, which is
 * how the loop converges — so nothing downstream will ever look at these again
 * and this gauge is the only thing left saying the erasure did not happen.
 * Counted over EVERY DONE record rather than only the swept ones, so it cannot
 * quietly age out of the window while the PII is still in Stripe.
 */
function reportFailedRedactions(done: ScannedDeletion[]): number {
  let failed = 0;
  for (const record of done) {
    const customerIds = failedRedactionCustomerIds(record);
    if (customerIds.length === 0) continue;
    failed += 1;
    console.error(
      '[account-deletion-orchestrator] A resurrected Stripe customer was left un-redacted: its ' +
        'Redaction Job ended in a terminal failure. Nothing re-drives a terminal job, so this ' +
        'needs manual follow-up in Stripe',
      { orgId: record.pk.slice('ORG#'.length), customerIds },
    );
  }
  return failed;
}

/**
 * Fold the orgs the guard sweep routed to a resweep into the sweep's own
 * findings, without double-invoking an org both found. Their surviving PROFILE
 * row is an `orgRows` hit by definition — that is what carries the fence.
 */
function mergeResurrected(swept: ResurrectedOrg[], fromFences: string[]): ResurrectedOrg[] {
  const merged = [...swept];
  const seen = new Set(swept.map((org) => org.orgId));
  for (const orgId of fromFences) {
    if (seen.has(orgId)) continue;
    seen.add(orgId);
    // No pending-redaction ids to carry: any org with one is a candidate by
    // definition, so the sweep already reported it and `seen` skipped it above.
    merged.push({ orgId, surfaces: ['orgRows'], userIds: [], pendingRedactionCustomerIds: [] });
  }
  return merged;
}

/**
 * Decide what to do about each org profile still carrying `deleting = true`
 * (FIL-112). The flag is written in exactly one place
 * (`lib/deletion-guards.ts`) and, until this ran, cleared in none — so an org
 * left flagged by a failed teardown could never create an access key or a RAG
 * key, toggle RAG on a bucket, or have a tenant provisioned again.
 *
 * Three cases, by the org's DELETION record:
 * - **Not DONE** — a teardown is genuinely in flight. Leave the fence alone.
 * - **DONE** — the profile outlived a completed teardown, so it is unpurged org
 *   data, not a live org. Re-drive the teardown; do NOT un-fence it. (This is
 *   narrower than "clear whenever nothing is non-DONE", deliberately: clearing
 *   here would re-open every fenced writer on an account we have told the user
 *   is deleted.)
 * - **Absent** — nothing anywhere is deleting this org, so the fence is
 *   orphaned. Clear it.
 *
 * The scan that produced these ids is eventually consistent, so "absent" here
 * only means "absent from the scan". It is never trusted: `clearOrgDeletionGuard`
 * asserts the record's absence transactionally against the write, which both
 * closes the start-a-deletion-mid-sweep race and removes the need for a
 * separate strongly-consistent read. The cost is that an org whose DONE record
 * the scan missed is not routed to a resweep on THIS run — the transaction
 * declines the clear, and the next run's scan sees the record and sweeps it.
 *
 * @param deadline epoch ms after which no further org is swept. One
 *   transaction per fenced org, sequential, inside the same window
 *   {@link SWEEP_BUDGET_MS} bounds — so a mass-fencing incident would otherwise
 *   silently shrink the sweep's share of the 300s Lambda to nothing. Orgs past
 *   it are counted, not dropped silently, and stay fenced for the next run.
 */
async function clearStaleDeletionGuards(
  guardedOrgIds: string[],
  statusByOrgId: Map<string, string>,
  deadline: number,
): Promise<{ unwedged: number; resweepOrgIds: string[]; skipped: number }> {
  const resweepOrgIds: string[] = [];
  let unwedged = 0;
  let skipped = 0;
  for (const orgId of guardedOrgIds) {
    const scannedStatus = statusByOrgId.get(orgId);
    if (scannedStatus !== undefined) {
      if (scannedStatus === OrgDeletionStatus.Done) resweepOrgIds.push(orgId);
      continue;
    }
    // Routing from the scan above is free; only the write below is not.
    if (Date.now() >= deadline) {
      skipped += 1;
      continue;
    }
    try {
      if (await clearOrgDeletionGuard(orgId)) {
        unwedged += 1;
        console.warn(
          '[account-deletion-orchestrator] Cleared an orphaned deletion fence: the org profile ' +
            'carried `deleting` with no DELETION record, so every fenced writer was refused ' +
            'and no teardown was running',
          { orgId },
        );
      }
    } catch (error) {
      console.error('[account-deletion-orchestrator] Failed to clear a stale deletion guard', {
        orgId,
        error,
      });
    }
  }
  if (skipped > 0) {
    console.warn(
      '[account-deletion-orchestrator] Budget expired before every guarded org was swept; ' +
        'the rest stay fenced until the next run',
      { skipped, guarded: guardedOrgIds.length },
    );
  }
  return { unwedged, resweepOrgIds, skipped };
}

/**
 * Staleness check with a NaN guard: a garbled or missing `updatedAt` parses
 * to NaN, and `NaN > x` is false — such a record would silently NEVER look
 * stale and never be re-driven. Treat it as stale (and warn) instead.
 */
function isStale(record: IncompleteDeletion, now: number): boolean {
  const updatedAtMs = new Date(record.updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    console.warn(
      '[account-deletion-orchestrator] Record has an unparseable updatedAt; treating as stale',
      {
        pk: record.pk,
        updatedAt: record.updatedAt,
      },
    );
    return true;
  }
  return now - updatedAtMs > STALE_AFTER_MS;
}

/** What the lean ProjectionExpression below actually returns per record. */
type IncompleteDeletion = Pick<OrgDeletionRecord, 'pk' | 'updatedAt' | 'attemptCount'>;

/**
 * Superset of {@link IncompleteDeletion}: every DELETION record now comes
 * back from the scan (DONE included), so the handler can route each record
 * by `status`. Everything past `status` is only read for DONE records —
 * `members` drives the sweep's billing probe, and the two redaction fields are
 * the sweep's `stripeRedaction` surface, which is answered from the record
 * alone rather than from a round trip.
 */
type ScannedDeletion = IncompleteDeletion &
  Pick<
    OrgDeletionRecord,
    'status' | 'members' | 'resurrectedStripeCustomerIds' | 'stripeRedactionJobStatuses'
  >;

interface ScanResult {
  deletions: ScannedDeletion[];
  /** Orgs whose PROFILE row still carries `deleting = true`. */
  guardedOrgIds: string[];
  /** Orgs named by a surviving `RAGKEYHASH#{hash}/LOOKUP` row. */
  ragKeyHashOrgIds: Set<string>;
}

// TODO: full-table Scan — cost grows with total users, not active deletions.
// The FilterExpression trims what is RETURNED, not what is read, so it saves no
// RCUs (which is also why the two extra row families below are free to add). At
// current scale (< a few thousand orgs, twice a day) that is fine. To make this
// O(active deletions), add a sparse GSI on a deletionStatus
// attribute carried only by non-DONE DELETION rows — with the wrinkle that
// DELETION rows are retained forever as audit records, so the finalize step
// must REMOVE the attribute for the index to stay O(active deletions). The
// DONE records, the fenced profiles and the key-hash lookups would still need
// their own (much cheaper — no RCU-relevant filter) path, but at least the
// per-org Scan cost disappears.
async function scanUserInfoTable(): Promise<ScanResult> {
  const result: ScanResult = { deletions: [], guardedOrgIds: [], ragKeyHashOrgIds: new Set() };
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        // begins_with(pk, :orgPrefix) keeps any future non-ORG row that
        // happens to carry an sk of DELETION out of the orchestrator (same
        // pattern as lib/stuck-tenant-metric.ts), and is load-bearing for
        // PROFILE: USER#{userId} rows use that sk too. No longer filters out
        // DONE records — the resurrection sweep needs those.
        FilterExpression:
          '(begins_with(pk, :orgPrefix) AND (sk = :deletion OR (sk = :profile AND deleting = :true)))' +
          ' OR (begins_with(pk, :hashPrefix) AND sk = :lookup)',
        // Trim the returned payload to what the handler actually reads. #s
        // (status) routes DONE vs. non-DONE; #m (members) drives the billing
        // half of the sweep; the two redaction fields are the `stripeRedaction`
        // surface (a resweep purges every other one, so without them a DONE
        // record with an unfinished Redaction Job reads as clean); orgId is
        // carried by the key-hash lookup rows.
        ProjectionExpression:
          'pk, sk, updatedAt, attemptCount, #s, #m, orgId, ' +
          'resurrectedStripeCustomerIds, stripeRedactionJobStatuses',
        ExpressionAttributeNames: { '#s': 'status', '#m': 'members' },
        ExpressionAttributeValues: {
          ':orgPrefix': { S: 'ORG#' },
          ':deletion': { S: 'DELETION' },
          ':profile': { S: 'PROFILE' },
          ':true': { BOOL: true },
          ':hashPrefix': { S: RagApiKeyKeys.lookupPk('') },
          ':lookup': { S: RagApiKeyKeys.lookupSk() },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) routeScannedRow(unmarshall(item), result);
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return result;
}

/** Sort one scanned row into the bucket its sk identifies. */
function routeScannedRow(row: Record<string, unknown>, into: ScanResult): void {
  const pk = typeof row.pk === 'string' ? row.pk : '';
  if (row.sk === 'DELETION') into.deletions.push(row as unknown as ScannedDeletion);
  else if (row.sk === 'PROFILE') into.guardedOrgIds.push(pk.slice('ORG#'.length));
  else if (typeof row.orgId === 'string' && row.orgId) into.ragKeyHashOrgIds.add(row.orgId);
}
