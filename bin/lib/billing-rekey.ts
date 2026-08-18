// Pure helpers for the billing re-key (IAM M1, FIL-1013): what to do with each
// subscription row, and the exact DynamoDB items that carry it out. Everything
// here is a function of its arguments — no AWS client, no `Resource`, no clock —
// so the decisions are testable without a table.
//
// The runners are ./backfill-billing-to-org.ts and ./revert-billing-backfill.ts;
// the procedure is docs/BillingRekeyRunbook.md.
//
// KEY BUILDERS ARE MIRRORED, NOT IMPORTED, for the same reason
// ./org-conversion.ts records: bin scripts run as `node ./bin/<script>.ts` under
// Node's type stripping, which resolves neither the backend's `./x.js`
// specifiers nor its enums. The canonical definitions live in
// packages/backend/src/lib/subscription-store.ts (`SubscriptionKeys`), and
// ./billing-rekey.test.ts imports that module and asserts the values here equal
// it, so the mirror cannot drift silently.

import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';

/** BillingTable keys — mirror of `SubscriptionKeys` in the backend's subscription-store. */
export const BillingKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  orgPkPrefix: (): string => 'ORG#',
  legacyPk: (userId: string): string => `CUSTOMER#${userId}`,
  legacyPkPrefix: (): string => 'CUSTOMER#',
  subscriptionSk: (): string => 'SUBSCRIPTION',
} as const;

/**
 * Attributes this backfill stamps on every row it writes, so a later run — and
 * the revert — can tell a copy from a row the application wrote itself.
 *
 * The application creates org rows too: since the dual-write deployed, a new
 * signup's trial and a first payment-method setup both write the org key
 * directly. Those rows are already correct and must never be overwritten by a
 * copy or removed by the revert, and provenance is the only thing that
 * distinguishes them.
 */
export const REKEY_ATTRIBUTES = {
  /** The legacy pk this row was copied from. */
  from: 'rekeyedFrom',
  /** When the copy ran. */
  at: 'rekeyedAt',
  /** The source row's `updatedAt` at copy time — what a delta re-copy compares against. */
  sourceUpdatedAt: 'rekeySourceUpdatedAt',
} as const;

/** `CUSTOMER#{userId}` -> userId. Undefined for the org key or any other shape. */
export function parseLegacyPk(pk: string): string | undefined {
  return parsePrefixed(pk, BillingKeys.legacyPkPrefix());
}

/** `ORG#{orgId}` -> orgId. */
export function parseOrgPk(pk: string): string | undefined {
  return parsePrefixed(pk, BillingKeys.orgPkPrefix());
}

function parsePrefixed(value: string, prefix: string): string | undefined {
  const rest = value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  return isKeyable(rest) ? rest : undefined;
}

/**
 * Whether an id can be half of a key.
 *
 * `#` separates a key's parts, so an id containing one produces a partition key
 * that parses back as something else — `ORG#a#b` reads as an org named `a#b` to
 * a `startsWith` test and as nothing at all to these parsers. Ids here are
 * UUIDs and Auth0 subs; neither contains a `#`, so a value that does is not the
 * thing it claims to be and is refused rather than half-accepted.
 *
 * The backend's `SubscriptionKeys.isOrgPk` is a bare `startsWith` and does
 * accept those shapes. That is deliberate on its side — a scan filter that
 * errs towards seeing a row is safer than one that skips it — but it means the
 * two disagree about `ORG#a#b`, so this script names such a row as an anomaly
 * rather than assuming nobody else can see it.
 */
export function isKeyable(id: string | undefined): id is string {
  return id !== undefined && id.length > 0 && !id.includes('#');
}

/**
 * The attributes that decide whether two rows describe the same subscription,
 * and whether a copy is still faithful to its source.
 *
 * Deliberately not every attribute: `rekeyedFrom` and friends exist only on the
 * copy, `pk` differs by construction, and `userId` is an attribute on the org
 * row and a key component on the legacy one. What is left is the billing state
 * a stale copy would misreport.
 */
export const COMPARED_ATTRIBUTES = [
  'subscriptionId',
  'stripeCustomerId',
  'subscriptionStatus',
  'currentPeriodStart',
  'currentPeriodEnd',
  'trialStartedAt',
  'trialEndsAt',
  'gracePeriodEndsAt',
  'canceledAt',
  'lastPaymentAt',
  'lastPaymentFailedAt',
  'updatedAt',
] as const;

/** One BillingTable `SUBSCRIPTION` row, as the scan decodes it. */
export interface SubscriptionRow {
  pk: string;
  /** Every attribute the row carries, `pk`/`sk` included. */
  attributes: Record<string, AttributeValue>;
  orgId?: string;
  subscriptionId?: string;
  updatedAt?: string;
  /** Set only on a row this backfill wrote. */
  rekeyedFrom?: string;
  rekeySourceUpdatedAt?: string;
}

/** Everything known about one org's billing, assembled from the scan. */
export interface OrgBillingState {
  orgId: string;
  /** `CUSTOMER#` rows naming this org. More than one is a collision. */
  legacyRows: SubscriptionRow[];
  /** The `ORG#{orgId}/SUBSCRIPTION` row, if it exists yet. */
  orgRow?: SubscriptionRow;
}

/** Why a row is left for a human. */
export type BillingAnomalyReason =
  | 'collision'
  | 'no-org-id'
  | 'foreign-org-row'
  | 'app-row-behind'
  | 'app-row-mismatch';

export interface CopyPlan {
  kind: 'copy';
  orgId: string;
  userId: string;
  source: SubscriptionRow;
  /** A first copy, or a re-copy of a source that changed after the last one. */
  reason: 'first-copy' | 'delta';
  /** What the org row's `updatedAt` says today: the delta log line, and the write's own condition. */
  copiedUpdatedAt?: string;
  /** The source's `updatedAt` now. */
  sourceUpdatedAt?: string;
  /** Collision resolution: the losing rows an operator signed off on leaving behind. */
  supersedes?: string[];
}

export interface AlreadyCopiedPlan {
  kind: 'already-copied';
  orgId: string;
  /** `backfill` when this run's predecessor wrote it, `application` when a signup did. */
  origin: 'backfill' | 'application';
}

/** Whether a row is newer than another, with an absent timestamp counting as oldest. */
function isNewerThan(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') > (b ?? '');
}

export interface BillingAnomalyPlan {
  kind: 'anomaly';
  orgId: string;
  reason: BillingAnomalyReason;
  detail: string;
  /** The legacy rows involved, so a disposition can name them. */
  rows: string[];
}

export type BillingPlan = CopyPlan | AlreadyCopiedPlan | BillingAnomalyPlan;

/**
 * What to do with one org's billing rows.
 *
 * The classification is a function of live data alone, which is what makes the
 * run resumable: a re-run re-reads the table and re-derives the same decision
 * for every org it already finished, so an interrupted run needs no checkpoint.
 *
 * THE SIGNAL IS WHICH ROW IS NEWER, not whether the source has moved since the
 * copy. Every ordinary dual-write moves the legacy row's `updatedAt` while the
 * copy's frozen `rekeySourceUpdatedAt` stays where it was, so the second reading
 * re-flags every account the run already finished: `--verify` could never
 * converge on a live stage, and each re-run put another delta Put over rows
 * nothing was wrong with.
 *
 * An org row that is newer than the legacy row is not a problem to fix. Every
 * reader prefers the org row while both exist, and the flip deletes the legacy
 * one — so the org half being ahead never serves anybody stale data, and it is a
 * reported count rather than a failure.
 *
 * `resolved` carries the operator's collision decisions — one winning userId per
 * org — and is consulted only for orgs whose decision is not already recorded on
 * the org row.
 */
export function classifyOrgBilling(
  state: OrgBillingState,
  resolved: ReadonlyMap<string, string> = new Map(),
): BillingPlan {
  const { orgId, orgRow, legacyRows } = state;

  if (legacyRows.length === 0) {
    // Either an org row from a previous run whose source is gone, or one the
    // application wrote and never had a legacy twin scanned for. Nothing to
    // copy; deleting an orphaned copy is the revert's job, not this one's.
    return {
      kind: 'already-copied',
      orgId,
      origin: orgRow?.rekeyedFrom ? 'backfill' : 'application',
    };
  }

  const source = chooseSource(state, resolved);
  if (!source) return unresolvedSourceAnomaly(state);

  if (!orgRow) return copyPlan(state, source, 'first-copy');

  if (!orgRow.rekeyedFrom) return applicationRowPlan(orgId, orgRow, source);

  // The org row records which legacy row won, so the source is settled. What is
  // left is which half is newer.
  if (isNewerThan(source.updatedAt, orgRow.updatedAt)) {
    return copyPlan(state, source, 'delta', orgRow.updatedAt);
  }

  return { kind: 'already-copied', orgId, origin: 'backfill' };
}

/**
 * One org whose org row the application wrote, weighed against the legacy row
 * still claiming it.
 *
 * The row is never overwritten: it is live billing state with no provenance, so
 * a copy over it could not be reverted and might not even describe the same
 * subscription. It is still compared, because two subscriptions claiming one org
 * and a legacy row holding newer state are both things the operator has to know
 * before the flip drops the legacy key.
 *
 * Identity comes first, and an absent `subscriptionId` agrees with nothing. Two
 * rows naming different subscriptions is a fact about the account whichever of
 * them was written last, and nothing downstream would catch it: verification
 * exempts a row with no `rekeyedFrom` from the faithfulness check, and the
 * timestamp comparison reads a newer org row as settled.
 */
function applicationRowPlan(
  orgId: string,
  orgRow: SubscriptionRow,
  source: SubscriptionRow,
): BillingPlan {
  if ((orgRow.subscriptionId ?? '') !== (source.subscriptionId ?? '')) {
    return {
      kind: 'anomaly',
      orgId,
      reason: 'app-row-mismatch',
      detail:
        `the application's org row names subscription ${orgRow.subscriptionId ?? '(none)'} while ` +
        `${source.pk} names ${source.subscriptionId ?? '(none)'}, so one of the two is about to be ` +
        'lost when the flip deletes the legacy row. Confirm in Stripe which subscription is live, ' +
        'then reconcile the two by hand',
      rows: [source.pk],
    };
  }

  if (!isNewerThan(source.updatedAt, orgRow.updatedAt)) {
    return { kind: 'already-copied', orgId, origin: 'application' };
  }

  return {
    kind: 'anomaly',
    orgId,
    reason: 'app-row-behind',
    detail:
      `the application's org row (updatedAt=${orgRow.updatedAt ?? '(none)'}) is older than ` +
      `${source.pk} (updatedAt=${source.updatedAt ?? '(none)'}), and the flip deletes the legacy row. ` +
      'Reconcile the two by hand, or delete the org row and let the next run copy it',
    rows: [source.pk],
  };
}

/**
 * One org's copy, with the rows it leaves behind named.
 *
 * `supersedes` records the legacy rows that lost — either to a newer
 * `updatedAt` or to an operator's collision resolution — so the log says which
 * rows are being left in place rather than quietly dropping them from the plan.
 */
function copyPlan(
  state: OrgBillingState,
  source: SubscriptionRow,
  reason: CopyPlan['reason'],
  copiedUpdatedAt?: string,
): CopyPlan {
  const superseded = state.legacyRows.filter((row) => row.pk !== source.pk).map((row) => row.pk);

  return {
    kind: 'copy',
    orgId: state.orgId,
    userId: parseLegacyPk(source.pk)!,
    source,
    reason,
    ...(copiedUpdatedAt ? { copiedUpdatedAt } : {}),
    ...(source.updatedAt ? { sourceUpdatedAt: source.updatedAt } : {}),
    ...(superseded.length > 0 ? { supersedes: superseded } : {}),
  };
}

/**
 * Which legacy row this org's subscription comes from.
 *
 * A DECISION ALREADY RECORDED IS READ BACK, never re-derived — that is the first
 * thing this asks, before the count of rows. `rekeyedFrom` on the org row is the
 * winner a previous run copied, which for a collision is the row an operator
 * checked in Stripe and named. Re-deriving it would re-halt a resolved collision
 * on every subsequent run, and would need the same `--resolve-collisions`
 * argument passed forever.
 *
 * Otherwise: one row is the answer. Several that agree on the subscription are
 * re-subscription residue describing the same Stripe subscription, so the newest
 * `updatedAt` wins and the rest are recorded as superseded. Several that
 * disagree — including any claimant that names no subscription at all, which
 * agrees with nothing — are a real collision: the ADR's rule is that the row
 * whose `subscriptionId` is live in Stripe wins, and this script cannot ask
 * Stripe, so it halts and an operator names the winner on `--resolve-collisions`
 * after checking. Returns undefined when that decision has not been made.
 */
function chooseSource(
  state: OrgBillingState,
  resolved: ReadonlyMap<string, string>,
): SubscriptionRow | undefined {
  const { legacyRows, orgId, orgRow } = state;

  const recorded = orgRow?.rekeyedFrom;
  if (recorded) return legacyRows.find((row) => row.pk === recorded);

  if (legacyRows.length === 1) return legacyRows[0];

  const chosen = resolved.get(orgId);
  if (chosen) return legacyRows.find((row) => parseLegacyPk(row.pk) === chosen);

  const subscriptionIds = legacyRows.map((row) => row.subscriptionId ?? '');
  if (subscriptionIds.some((id) => id === '')) return undefined;
  if (new Set(subscriptionIds).size > 1) return undefined;

  return [...legacyRows].sort(byUpdatedAtDescending)[0];
}

/** Newest first; a row with no `updatedAt` sorts last, being the least likely to be current. */
function byUpdatedAtDescending(a: SubscriptionRow, b: SubscriptionRow): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

/**
 * No source could be chosen. Which anomaly that is depends on whether a decision
 * was recorded and has since gone missing, or was never made at all.
 */
function unresolvedSourceAnomaly(state: OrgBillingState): BillingAnomalyPlan {
  const recorded = state.orgRow?.rekeyedFrom;
  if (recorded) {
    const survivors = state.legacyRows.map((row) => row.pk);
    return {
      kind: 'anomaly',
      orgId: state.orgId,
      reason: 'foreign-org-row',
      detail:
        `the org row was copied from ${recorded}, which is no longer in the table, ` +
        `while ${survivors.join(', ')} still claim this org. Confirm in Stripe which subscription is ` +
        `live: if it is the surviving row, delete the org row and re-run so it is copied afresh; ` +
        `if the recorded winner was deleted in error, the org row already holds its state and nothing is needed`,
      rows: [recorded, ...survivors],
    };
  }
  return collisionAnomaly(state);
}

function collisionAnomaly(state: OrgBillingState): BillingAnomalyPlan {
  const described = state.legacyRows
    .map((row) => `${row.pk} (${row.subscriptionId ?? 'no subscriptionId'})`)
    .join(', ');
  return {
    kind: 'anomaly',
    orgId: state.orgId,
    reason: 'collision',
    detail: `${state.legacyRows.length} legacy rows name this org with different subscriptions: ${described}`,
    rows: state.legacyRows.map((row) => row.pk),
  };
}

/**
 * The legacy rows whose `orgId` attribute cannot be half of a key, as one
 * anomaly per org they claim.
 *
 * These rows are held out of the grouping rather than filed under the org they
 * name: `ORG#a#b` is a key {@link isKeyable} refuses and the backend's
 * `startsWith` accepts, so a copy written there is a row the application can
 * read and this script can no longer account for. Naming them as anomalies puts
 * them in the plan a dry run prints, which is what `--execute` then skips —
 * `findUnkeyableOrgIds` says the same thing from the verify side, after the
 * fact.
 */
export function unkeyableOrgAnomalies(rows: readonly SubscriptionRow[]): BillingAnomalyPlan[] {
  const byOrg = new Map<string, string[]>();

  for (const row of rows) {
    if (row.orgId === undefined || isKeyable(row.orgId)) continue;
    byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row.pk]);
  }

  return [...byOrg]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([orgId, pks]) => ({
      kind: 'anomaly',
      orgId,
      reason: 'no-org-id',
      detail:
        `orgId=${JSON.stringify(orgId)} cannot be half of a key, so ${pks.join(', ')} has no org ` +
        'row to copy to. Correct the attribute on the row, or dispose of the row, before the flip',
      rows: pks,
    }));
}

/**
 * The org-keyed copy of one legacy row.
 *
 * Every attribute travels, so nothing the application stored is lost in the
 * move, with three replaced and three added. `pk` becomes the org key. `orgId`
 * is written from the classification rather than copied, so the row's key and
 * its attribute can never disagree. `userId` is written from the source's key,
 * which is where it lived until now — the usage worker needs it to close out a
 * deleted Stripe customer, and after the flip there is no pk left to parse it
 * out of.
 */
export function buildCopyItem(
  plan: CopyPlan,
  now: string,
): { item: Record<string, AttributeValue>; pk: string } {
  const { orgId, userId, source } = plan;
  const pk = BillingKeys.orgPk(orgId);
  const { pk: _sourcePk, ...carried } = source.attributes;

  return {
    pk,
    item: {
      ...carried,
      pk: { S: pk },
      sk: { S: BillingKeys.subscriptionSk() },
      orgId: { S: orgId },
      userId: { S: userId },
      [REKEY_ATTRIBUTES.from]: { S: source.pk },
      [REKEY_ATTRIBUTES.at]: { S: now },
      ...(source.updatedAt ? { [REKEY_ATTRIBUTES.sourceUpdatedAt]: { S: source.updatedAt } } : {}),
    },
  };
}

/**
 * The copy as a single transaction: the org row is written, and the legacy row
 * is asserted to still hold the `updatedAt` this copy claims to carry.
 *
 * The ConditionCheck is what makes the copy honest under a live webhook. Between
 * the scan and this write, Stripe can move the legacy row; without the check the
 * copy would land carrying a `rekeySourceUpdatedAt` that no longer matches
 * anything, and the next run would read the pair as consistent and never
 * revisit it. Failing instead leaves the org for the next run, which re-reads
 * and copies the newer row.
 *
 * A first copy asserts the org row's absence. A delta asserts BOTH halves are
 * still what the classification read: the row is still a copy of this source,
 * and its `updatedAt` is still the one that lost the comparison. Without the
 * second half, a webhook write landing on the org row inside the window is
 * silently replaced by a copy that was already older than it — a Put replaces
 * the whole item, so the newer state is not merged, it is gone. Asserting it
 * makes that a race the run reports and the next one re-reads.
 */
export function buildCopyTransactItems(
  plan: CopyPlan,
  tableName: string,
  now: string,
): TransactWriteItem[] {
  const { item } = buildCopyItem(plan, now);
  const sourceUnchanged = plan.source.updatedAt
    ? {
        ConditionExpression: '#updatedAt = :sourceUpdatedAt',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':sourceUpdatedAt': { S: plan.source.updatedAt } },
      }
    : {
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#updatedAt)',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      };

  return [
    {
      Put: {
        TableName: tableName,
        Item: item,
        ...(plan.reason === 'first-copy'
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : orgRowUnchanged(plan)),
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { pk: { S: plan.source.pk }, sk: { S: BillingKeys.subscriptionSk() } },
        ...sourceUnchanged,
      },
    },
  ];
}

/** The delta's condition on the row it is replacing: same source, same `updatedAt`. */
function orgRowUnchanged(plan: CopyPlan): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
} {
  const names = { '#rekeyedFrom': REKEY_ATTRIBUTES.from, '#updatedAt': 'updatedAt' };
  if (plan.copiedUpdatedAt === undefined) {
    return {
      ConditionExpression: '#rekeyedFrom = :source AND attribute_not_exists(#updatedAt)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':source': { S: plan.source.pk } },
    };
  }
  return {
    ConditionExpression: '#rekeyedFrom = :source AND #updatedAt = :orgUpdatedAt',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: {
      ':source': { S: plan.source.pk },
      ':orgUpdatedAt': { S: plan.copiedUpdatedAt },
    },
  };
}

/**
 * Remove one copied org row.
 *
 * Conditional on the row still being a copy of the source the revert read, so a
 * row the application wrote since — or a copy of a different legacy row — is
 * left alone. The legacy row is untouched by both directions: the backfill never
 * deleted it, which is what makes the revert a delete and not a restore.
 *
 * And conditional on that legacy row still existing AND still serving this org.
 * The revert's whole claim is that every read falls back to the `CUSTOMER#` row,
 * so the accounts it reverts keep working — after the dated cleanup step there
 * is no such row, and running this then would delete the only subscription an
 * account has while printing that nothing was lost. The store's fallback is
 * narrower than "the row exists": a legacy row whose `orgId` names a different
 * org is refused, and a row carrying no `orgId` is served, so the condition is
 * written the same way. Asserting the fallback the application actually applies
 * makes the claim true: the revert declines per org rather than emptying the
 * table.
 */
export function buildRevertItem(
  orgId: string,
  rekeyedFrom: string,
  tableName: string,
): TransactWriteItem[] {
  return [
    {
      Delete: {
        TableName: tableName,
        Key: { pk: { S: BillingKeys.orgPk(orgId) }, sk: { S: BillingKeys.subscriptionSk() } },
        ConditionExpression: 'attribute_exists(pk) AND #rekeyedFrom = :source',
        ExpressionAttributeNames: { '#rekeyedFrom': REKEY_ATTRIBUTES.from },
        ExpressionAttributeValues: { ':source': { S: rekeyedFrom } },
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { pk: { S: rekeyedFrom }, sk: { S: BillingKeys.subscriptionSk() } },
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(#orgId) OR #orgId = :orgId)',
        ExpressionAttributeNames: { '#orgId': 'orgId' },
        ExpressionAttributeValues: { ':orgId': { S: orgId } },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** What the scan found, before any classification. */
export interface BillingScanCounts {
  /** Rows the scan's filter matched — `sk = SUBSCRIPTION` only, not the table's size. */
  subscriptionRows: number;
  legacyRows: number;
  orgRows: number;
  /** Org rows carrying this backfill's provenance attributes. */
  copiedOrgRows: number;
  /** Matched rows whose key parsed as neither shape. */
  unparsedRows: number;
  /** Legacy rows with no `orgId` attribute — reported, never copied. */
  orglessRows: number;
}

export interface BillingPlanCounts {
  orgs: number;
  firstCopies: number;
  deltas: number;
  alreadyCopiedByBackfill: number;
  alreadyCopiedByApplication: number;
  supersededRows: number;
  anomalies: number;
}

export function summarizeBillingPlans(plans: readonly BillingPlan[]): BillingPlanCounts {
  const counts: BillingPlanCounts = {
    orgs: plans.length,
    firstCopies: 0,
    deltas: 0,
    alreadyCopiedByBackfill: 0,
    alreadyCopiedByApplication: 0,
    supersededRows: 0,
    anomalies: 0,
  };

  for (const plan of plans) {
    if (plan.kind === 'copy') {
      if (plan.reason === 'first-copy') counts.firstCopies++;
      else counts.deltas++;
      counts.supersededRows += plan.supersedes?.length ?? 0;
    } else if (plan.kind === 'already-copied') {
      if (plan.origin === 'backfill') counts.alreadyCopiedByBackfill++;
      else counts.alreadyCopiedByApplication++;
    } else {
      counts.anomalies++;
    }
  }

  return counts;
}

/**
 * The report both modes print before anything is written. Execute prints the
 * same plan a dry run does, so what an operator approves is what runs.
 */
export function formatBillingPlanReport(
  scan: BillingScanCounts,
  plans: readonly BillingPlan[],
  orglessRows: readonly string[],
): string {
  const counts = summarizeBillingPlans(plans);
  const writes = counts.firstCopies + counts.deltas;

  return [
    `Matched in BillingTable: ${scan.subscriptionRows} SUBSCRIPTION rows — ${scan.legacyRows} legacy CUSTOMER# rows, ${scan.orgRows} ORG# rows (${scan.copiedOrgRows} of them copies)`,
    ...(scan.unparsedRows > 0 ? [`  Unrecognized key shapes, ignored: ${scan.unparsedRows}`] : []),
    '',
    `Orgs scanned: ${counts.orgs}`,
    ...alignedCounts([
      ['  Copy (CUSTOMER# row -> ORG# row)', counts.firstCopies],
      ['  Re-copy (the legacy row is newer than the org row)', counts.deltas],
      ['  In sync, or the org row is ahead (skipped)', counts.alreadyCopiedByBackfill],
      ['  Keyed to the org by the application (skipped)', counts.alreadyCopiedByApplication],
      ['  Superseded legacy rows left in place', counts.supersededRows],
      ['  Anomalies (manual disposition)', counts.anomalies],
    ]),
    '',
    ...formatOrglessRows(scan, orglessRows),
    ...formatBillingAnomalies(plans),
    `Writes ${writes} org rows and deletes nothing. Every CUSTOMER# row stays until the dated cleanup step.`,
  ].join('\n');
}

/** One column of labels, one of numbers — the counts are meant to be compared down the page. */
function alignedCounts(rows: readonly (readonly [string, number])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`);
}

/**
 * The rows with no `orgId`, enumerated in full.
 *
 * There is no org to key them to and nothing to infer one from, so the backfill
 * never touches them. Every lifecycle job already skips them, which is why they
 * have gone unnoticed; the list is here because the flip is what makes that
 * permanent.
 */
function formatOrglessRows(scan: BillingScanCounts, orglessRows: readonly string[]): string[] {
  if (scan.orglessRows === 0) return ['Legacy rows with no orgId: none.', ''];

  return [
    `Legacy rows with no orgId (${scan.orglessRows}) — never copied, for manual disposition:`,
    ...orglessRows.map((pk) => `  ${pk}`),
    '',
  ];
}

function formatBillingAnomalies(plans: readonly BillingPlan[]): string[] {
  const anomalies = plans.filter((plan): plan is BillingAnomalyPlan => plan.kind === 'anomaly');
  if (anomalies.length === 0) return ['Anomalies: none.', ''];

  return [
    'Anomalies — dispose of these before executing:',
    ...anomalies.map(
      (plan) => `  [${plan.reason}] ${BillingKeys.orgPk(plan.orgId)}  ${plan.detail}`,
    ),
    '',
  ];
}

/**
 * Parse `--resolve-collisions` into the winning userId per org.
 *
 * The entries an operator has in front of them are the report's `ORG#{orgId}`
 * and `CUSTOMER#{userId}` lines, so both those forms and the bare ids are
 * accepted — copying from the output is the expected way to build the list.
 * Each entry is `<org>=<user>`, because the decision is which of that org's rows
 * is the live one, and it is one decision per org.
 */
export function parseResolvedCollisions(value: string | undefined): Map<string, string> {
  const resolved = new Map<string, string>();

  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const [org, user] = trimmed.split('=');
    if (!org || !user) {
      throw new Error(
        `--resolve-collisions entries are <orgId>=<userId>; could not read "${trimmed}"`,
      );
    }
    const orgId = stripPrefix(org.trim(), BillingKeys.orgPkPrefix());
    const userId = stripPrefix(user.trim(), BillingKeys.legacyPkPrefix());

    // One decision per org. Two entries for one org is an operator who edited a
    // list and left the old line in, and taking the last silently would copy a
    // subscription they had already decided against.
    const existing = resolved.get(orgId);
    if (existing && existing !== userId) {
      throw new Error(
        `--resolve-collisions names ${BillingKeys.orgPk(orgId)} twice, as ` +
          `${BillingKeys.legacyPk(existing)} and ${BillingKeys.legacyPk(userId)}. ` +
          'Each org gets one winner.',
      );
    }
    resolved.set(orgId, userId);
  }

  return resolved;
}

/**
 * Every resolution checked against the rows actually scanned.
 *
 * An entry naming a row that is not there is a typo or a stale list, and it is
 * silent in the worst way: the org stays unresolved, the run halts on the same
 * collision, and the operator reads the halt as the resolution not having been
 * applied at all. Returns the problems as sentences, empty when the list is good.
 */
export function validateResolvedCollisions(
  resolved: ReadonlyMap<string, string>,
  states: readonly OrgBillingState[],
): string[] {
  const byOrg = new Map(states.map((state) => [state.orgId, state]));
  const problems: string[] = [];

  for (const [orgId, userId] of resolved) {
    const state = byOrg.get(orgId);
    if (!state) {
      problems.push(
        `${BillingKeys.orgPk(orgId)}=${BillingKeys.legacyPk(userId)} — no scanned row names that org`,
      );
      continue;
    }
    if (!state.legacyRows.some((row) => parseLegacyPk(row.pk) === userId)) {
      const claimants = state.legacyRows.map((row) => row.pk).join(', ') || '(none)';
      problems.push(
        `${BillingKeys.orgPk(orgId)}=${BillingKeys.legacyPk(userId)} — that row does not claim this org; ` +
          `its claimants are ${claimants}`,
      );
    }
  }

  return problems;
}

/** The resolutions this run applied, for the report an operator keeps. */
export function formatAppliedResolutions(
  resolved: ReadonlyMap<string, string>,
  plans: readonly BillingPlan[],
): string[] {
  if (resolved.size === 0) return [];

  const planByOrg = new Map(plans.map((plan) => [plan.orgId, plan]));
  return [
    `Collision resolutions applied (${resolved.size}):`,
    ...[...resolved].map(([orgId, userId]) => {
      const plan = planByOrg.get(orgId);
      const outcome =
        plan?.kind === 'copy'
          ? `${plan.reason === 'first-copy' ? 'copy' : 're-copy'} from ${plan.source.pk}`
          : plan?.kind === 'already-copied'
            ? `already keyed to the org (${plan.origin})`
            : `still an anomaly (${plan?.reason ?? 'org not scanned'})`;
      return `  ${BillingKeys.orgPk(orgId)} = ${BillingKeys.legacyPk(userId)} — ${outcome}`;
    }),
    '',
  ];
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
