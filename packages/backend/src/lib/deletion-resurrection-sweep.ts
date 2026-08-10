import { QueryCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { batchGet } from './dynamo-batch-get.js';
import { DeletionKeys, RAGKeys } from './dynamo-records.js';
import { settleAll } from './settle-all.js';

const dynamo = getDynamoClient();

/** One recently-DONE org to check, with the members its DELETION record snapshotted. */
export interface SweepCandidate {
  orgId: string;
  userIds: string[];
  /**
   * Stripe customers this org resurrected whose Redaction Job has not reached a
   * terminal status, read straight off the DELETION record by the caller
   * (`pendingRedactionCustomerIds`, lib/dynamo-records.ts). Costs no round trip
   * and is checked like any other surface — see the `stripeRedaction` entry on
   * {@link sweepResurrectedOrgs}.
   */
  pendingRedactionCustomerIds: string[];
}

/** Named surfaces a sweep can find rows on, so the warn says WHERE, not just that. */
export type ResurrectedSurface =
  | 'billing'
  | 'orgRows'
  | 'ragIndex'
  | 'ragKeyHash'
  | 'stripeRedaction';

export interface ResurrectedOrg {
  orgId: string;
  /** Every surface that still carried at least one row for this org. */
  surfaces: ResurrectedSurface[];
  /** Members whose `CUSTOMER#/SUBSCRIPTION` row is back; empty unless `billing` is present. */
  userIds: string[];
  /** Resurrected customers still awaiting redaction; empty unless `stripeRedaction` is present. */
  pendingRedactionCustomerIds: string[];
}

export interface SweepResult {
  resurrected: ResurrectedOrg[];
  /** Candidates whose org-partition query was not attempted because the deadline passed. */
  skipped: number;
  /**
   * The RagIndexerTable scan stopped early on the deadline, so the `ragIndex`
   * surface is UNCHECKED for every candidate this run — a scan has no per-org
   * granularity to report. Reported rather than silently treated as "no rows".
   */
  ragIndexTruncated: boolean;
}

/**
 * Rows per page of the org-partition probe. The question it answers is "does
 * anything besides the retained DELETION audit row exist in this partition?",
 * so a purged org answers it in one round trip returning one item.
 */
const ORG_PROBE_PAGE_SIZE = 25;

/**
 * Look for rows that came back after a completed teardown (FIL-112), across
 * every surface the purge clears:
 *
 * - **billing** — BillingTable `CUSTOMER#{userId}/SUBSCRIPTION` for the members
 *   the DELETION record snapshotted. `createBillingTrial` does stamp `orgId` on
 *   that row (lib/create-billing-trial.ts), so a
 *   `begins_with(pk, 'CUSTOMER#') AND orgId = :orgId` Scan could find it — but
 *   a Scan reads the whole table per org and a targeted BatchGet does not, and
 *   the DELETION record's `members` gives the exact keys for free. (The row
 *   carries no `deletionRequestedAt`: the fence is what sets that, and it never
 *   ran against a row written after the teardown finished.)
 * - **orgRows** — any UserInfoTable `ORG#{orgId}` row other than the DELETION
 *   record itself, which is retained forever as the audit record. Catches a
 *   surviving PROFILE (which re-opens every fence-B writer), access keys and
 *   RAG key records.
 * - **ragIndex** — RagIndexerTable per-bucket RAG enablement rows. Only the
 *   enablement row is probed: it is the self-sustaining one that
 *   `jobs/rag-indexer-orchestrator.ts` fans out on, and the resweep's
 *   `purgeRagData` deletes the whole `BUCKET#`/`INDEXER_CHECKPOINT#` families
 *   wholesale. A MANIFEST#/CHECKPOINT# row with no enablement row above it is
 *   therefore NOT detected here.
 * - **ragKeyHash** — `RAGKEYHASH#{hash}/LOOKUP` rows naming this org, harvested
 *   by the caller from the UserInfoTable scan it already runs.
 * - **stripeRedaction** — no rows at all: a resurrected Stripe customer whose
 *   Redaction Job has not reached a terminal status, read off the DELETION
 *   record itself. It is a surface for the same reason as the rest — it is
 *   residue of a resurrection that has not converged — but it is the ONLY one
 *   the resweep does not clear as it goes. A resweep purges every other surface
 *   before its held Stripe failure is rethrown, so the next run would find the
 *   org spotless and stop re-driving it while the customer's PII sat in Stripe
 *   un-redacted, driven by nothing but Lambda's two bounded async retries. This
 *   surface survives the purge because it is not made of rows the purge can
 *   delete.
 *
 * Every writer behind these was fenced earlier in this stack, so a hit today
 * means either a row written before the fences shipped or a gap in them — the
 * caller logs it as such.
 *
 * Failure of one surface is logged and does not suppress the others: the
 * resweep this feeds is idempotent, so a surface missed on one run is simply
 * probed again on the next.
 *
 * @param deadline epoch ms after which no further round trip is STARTED. Two
 *   parts of this sweep are unbounded and both honour it: the org-partition
 *   probe (one query per candidate, so it scales with the window) and the
 *   RagIndexerTable scan (which reads every item in a high-churn table —
 *   `FilterExpression` narrows what is RETURNED, never what is read, so its
 *   cost scales with total manifest count, not with the candidate list). Only
 *   `findBillingRows` is genuinely a bounded number of round trips. Lost
 *   coverage is reported — `skipped` per candidate, `ragIndexTruncated` for the
 *   scan — not dropped silently, and everything stays in the window for the
 *   next run.
 */
export async function sweepResurrectedOrgs(args: {
  candidates: SweepCandidate[];
  ragKeyHashOrgIds: Set<string>;
  deadline: number;
}): Promise<SweepResult> {
  const { candidates, ragKeyHashOrgIds, deadline } = args;
  if (candidates.length === 0) return { resurrected: [], skipped: 0, ragIndexTruncated: false };

  let billing = new Map<string, string[]>();
  let ragIndex = new Set<string>();
  let ragIndexTruncated = false;
  await attemptAll([
    {
      name: 'billing',
      run: async () => {
        billing = await findBillingRows(candidates);
      },
    },
    {
      name: 'ragIndex',
      run: async () => {
        const scan = await findRagIndexOrgIds(candidates, deadline);
        ragIndex = scan.orgIds;
        ragIndexTruncated = scan.truncated;
      },
    },
  ]);

  const { orgRows, skipped } = await probeOrgPartitions(candidates, deadline);

  const found = { billing, orgRows, ragIndex, ragKeyHash: ragKeyHashOrgIds };
  const resurrected: ResurrectedOrg[] = [];
  for (const candidate of candidates) {
    const surfaces = resurrectedSurfaces(candidate, found);
    if (surfaces.length === 0) continue;
    resurrected.push({
      orgId: candidate.orgId,
      surfaces,
      userIds: billing.get(candidate.orgId) ?? [],
      pendingRedactionCustomerIds: candidate.pendingRedactionCustomerIds,
    });
  }
  return { resurrected, skipped, ragIndexTruncated };
}

/** Every surface that carried residue for one candidate, in a stable order. */
function resurrectedSurfaces(
  candidate: SweepCandidate,
  found: {
    billing: Map<string, string[]>;
    orgRows: Set<string>;
    ragIndex: Set<string>;
    ragKeyHash: Set<string>;
  },
): ResurrectedSurface[] {
  const { orgId } = candidate;
  const surfaces: ResurrectedSurface[] = [];
  if (found.billing.has(orgId)) surfaces.push('billing');
  if (found.orgRows.has(orgId)) surfaces.push('orgRows');
  if (found.ragIndex.has(orgId)) surfaces.push('ragIndex');
  if (found.ragKeyHash.has(orgId)) surfaces.push('ragKeyHash');
  // Last, and never suppressed by a probe failure or a skipped deadline: it is
  // answered from the candidate itself, not from a round trip.
  if (candidate.pendingRedactionCustomerIds.length > 0) surfaces.push('stripeRedaction');
  return surfaces;
}

/** settleAll's "attempt everything" without its "then fail" — a probe failure must not abort the sweep. */
async function attemptAll(tasks: { name: string; run: () => Promise<void> }[]): Promise<void> {
  try {
    await settleAll(tasks, (names) => `Resurrection sweep probe(s) failed: ${names}`);
  } catch (error) {
    // settleAll's message names the failed surfaces; log it alongside the
    // error so the line says WHICH surfaces went unchecked, not just that some
    // did. `error.errors` carries the underlying causes.
    console.error('[deletion-sweep] Probe failed; those surfaces are unchecked this run', {
      surfaces: error instanceof Error ? error.message : String(error),
      error,
    });
  }
}

/**
 * ONE chunked cross-org BatchGetItem over every candidate's member billing
 * keys (the helper chunks at 100), rather than one round trip per org.
 * Returns orgId → the userIds whose row is actually still there.
 */
async function findBillingRows(candidates: SweepCandidate[]): Promise<Map<string, string[]>> {
  const orgIdByUserId = new Map<string, string>();
  for (const { orgId, userIds } of candidates) {
    for (const userId of userIds) orgIdByUserId.set(userId, orgId);
  }
  if (orgIdByUserId.size === 0) return new Map();

  const keys = [...orgIdByUserId.keys()].map((userId) => ({
    pk: `CUSTOMER#${userId}`,
    sk: 'SUBSCRIPTION',
  }));
  const survivors = await batchGet(Resource.BillingTable.name, keys);

  const byOrg = new Map<string, string[]>();
  for (const item of survivors) {
    if (typeof item.pk !== 'string') continue;
    const userId = item.pk.slice('CUSTOMER#'.length);
    const orgId = orgIdByUserId.get(userId);
    if (!orgId) continue;
    byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), userId]);
  }
  return byOrg;
}

/**
 * One paged Scan of RagIndexerTable for per-bucket RAG enablement rows,
 * narrowed to the candidate orgs. A Scan (not a Query) because the enablement
 * pk is `BUCKET#{orgId}#{region}#{bucketName}` — orgId is only a prefix of the
 * partition key, which a Query cannot address.
 *
 * **Deadline-bounded, and that is not optional.** RagIndexerTable is the
 * high-churn indexer store (one `MANIFEST#` row per indexed object, see
 * sst.config.ts), and a Scan reads every item regardless of the
 * `FilterExpression` — so this costs O(total manifests), not O(candidates), and
 * left unbounded it would consume the whole 300s Lambda before a single
 * resweep was invoked. That is the M7 starvation, moved from the billing
 * BatchGet to this table. Stopping early loses the `ragIndex` surface for the
 * whole run rather than for one org, so the caller is told (`truncated`) and
 * the next run re-scans from the top.
 *
 * Same table and projection as `jobs/rag-indexer-orchestrator.ts`, which scans
 * it on its own schedule — but a WIDER filter: the orchestrator also requires
 * `#status = :active` because it only wants buckets to index, while a
 * resurrected `disabled`/`paused` enablement row is still residue this sweep
 * must report. This runs only when the window holds at least one candidate.
 */
async function findRagIndexOrgIds(
  candidates: SweepCandidate[],
  deadline: number,
): Promise<{ orgIds: Set<string>; truncated: boolean }> {
  const wanted = new Set(candidates.map((candidate) => candidate.orgId));
  const orgIds = new Set<string>();
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    if (Date.now() >= deadline) {
      console.warn(
        '[deletion-sweep] Budget expired mid-scan of RagIndexerTable; the ragIndex surface is ' +
          'unchecked for every candidate this run',
        { candidates: candidates.length, found: orgIds.size },
      );
      return { orgIds, truncated: true };
    }
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'sk = :ragSk',
        ProjectionExpression: 'pk, orgId',
        ExpressionAttributeValues: marshall({ ':ragSk': RAGKeys.enablementSk() }),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    for (const item of result.Items ?? []) {
      const orgId = enablementOrgId(unmarshall(item));
      if (orgId && wanted.has(orgId)) orgIds.add(orgId);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return { orgIds, truncated: false };
}

/**
 * The org an enablement row belongs to. Prefers the stored `orgId` and falls
 * back to parsing the `BUCKET#{orgId}#{region}#{bucketName}` pk. The fallback
 * is defensive, not evidence: `jobs/rag-indexer-orchestrator.ts` skips rows
 * without a stored `orgId`, which says the writer's contract has been doubted
 * before, not that such rows are known to exist. Parsing the pk costs nothing
 * and this is a residue sweep, so the wider net is the right default.
 */
function enablementOrgId(row: Record<string, unknown>): string | undefined {
  if (typeof row.orgId === 'string' && row.orgId) return row.orgId;
  if (typeof row.pk !== 'string') return undefined;
  return RAGKeys.parseBucketPk(row.pk)?.orgId;
}

/**
 * Per-candidate probe of the UserInfoTable `ORG#{orgId}` partition: is there
 * anything left besides the DELETION record the teardown deliberately retains?
 * One query per candidate, so it is the only part of the sweep that scales with
 * the window — hence the deadline.
 *
 * A failing probe is logged and that org is skipped, so one org cannot abort
 * the rest.
 */
async function probeOrgPartitions(
  candidates: SweepCandidate[],
  deadline: number,
): Promise<{ orgRows: Set<string>; skipped: number }> {
  const orgRows = new Set<string>();
  let skipped = 0;
  for (const { orgId } of candidates) {
    if (Date.now() >= deadline) {
      skipped += 1;
      continue;
    }
    try {
      if (await hasNonDeletionOrgRow(orgId)) orgRows.add(orgId);
    } catch (error) {
      console.error('[deletion-sweep] Failed to probe the org partition', { orgId, error });
    }
  }
  return { orgRows, skipped };
}

/** True once any `ORG#{orgId}` row other than the retained DELETION record is seen. */
async function hasNonDeletionOrgRow(orgId: string): Promise<boolean> {
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk',
        ProjectionExpression: 'sk',
        Limit: ORG_PROBE_PAGE_SIZE,
        ExpressionAttributeValues: marshall({ ':pk': DeletionKeys.deletionPk(orgId) }),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    for (const item of result.Items ?? []) {
      if (item.sk?.S !== DeletionKeys.deletionSk()) return true;
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return false;
}
