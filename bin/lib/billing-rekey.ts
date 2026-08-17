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
  return rest && !rest.includes('#') ? rest : undefined;
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
export type BillingAnomalyReason = 'collision' | 'no-org-id' | 'foreign-org-row';

export interface CopyPlan {
  kind: 'copy';
  orgId: string;
  userId: string;
  source: SubscriptionRow;
  /** A first copy, or a re-copy of a source that changed after the last one. */
  reason: 'first-copy' | 'delta';
  /** What the org row's `rekeySourceUpdatedAt` says today, for the delta log line. */
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
 * `resolved` carries the operator's collision decisions — one winning userId per
 * org — and is consulted only for orgs that have one.
 */
export function classifyOrgBilling(
  state: OrgBillingState,
  resolved: ReadonlyMap<string, string> = new Map(),
): BillingPlan {
  const { orgId, orgRow, legacyRows } = state;

  // A row the application wrote for this org is already the truth: the
  // dual-write put it there alongside its legacy twin. Copying over it would
  // replace live state with whatever the scan happened to read.
  if (orgRow && !orgRow.rekeyedFrom) {
    return { kind: 'already-copied', orgId, origin: 'application' };
  }

  if (legacyRows.length === 0) {
    // An org row from a previous run whose source is gone. Nothing to copy, and
    // deleting it is the revert's job, not this one's.
    return { kind: 'already-copied', orgId, origin: 'backfill' };
  }

  const source = chooseSource(state, resolved);
  if (!source) return collisionAnomaly(state);

  // An org row copied from a different legacy row means two rows claim this org
  // and one already won. Silently re-pointing it would flip which subscription
  // the org rides on the strength of scan order.
  if (orgRow?.rekeyedFrom && orgRow.rekeyedFrom !== source.pk) {
    return {
      kind: 'anomaly',
      orgId,
      reason: 'foreign-org-row',
      detail: `the org row was copied from ${orgRow.rekeyedFrom}, but ${source.pk} is the row this run would copy`,
      rows: [orgRow.rekeyedFrom, source.pk],
    };
  }

  if (!orgRow) return copyPlan(state, source, 'first-copy');

  // The source moved after it was copied. This is the one way the two rows
  // diverge under dual-write: a Stripe object carrying no `metadata.orgId`
  // updates the legacy row alone, because the writer has no org to key with.
  if (orgRow.rekeySourceUpdatedAt !== source.updatedAt) {
    return copyPlan(state, source, 'delta', orgRow.rekeySourceUpdatedAt);
  }

  return { kind: 'already-copied', orgId, origin: 'backfill' };
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
 * One row is the answer. Several that agree on the subscription are
 * re-subscription residue describing the same Stripe subscription, so the newest
 * `updatedAt` wins and the rest are recorded as superseded. Several that
 * disagree are a real collision: the ADR's rule is that the row whose
 * `subscriptionId` is live in Stripe wins, and this script cannot ask Stripe —
 * so it halts and an operator names the winner on `--resolve-collisions` after
 * checking. Returns undefined when that decision has not been made.
 */
function chooseSource(
  state: OrgBillingState,
  resolved: ReadonlyMap<string, string>,
): SubscriptionRow | undefined {
  const { legacyRows, orgId } = state;
  if (legacyRows.length === 1) return legacyRows[0];

  const chosen = resolved.get(orgId);
  if (chosen) return legacyRows.find((row) => parseLegacyPk(row.pk) === chosen);

  const subscriptionIds = new Set(legacyRows.map((row) => row.subscriptionId ?? ''));
  if (subscriptionIds.size > 1) return undefined;

  return [...legacyRows].sort(byUpdatedAtDescending)[0];
}

/** Newest first; a row with no `updatedAt` sorts last, being the least likely to be current. */
function byUpdatedAtDescending(a: SubscriptionRow, b: SubscriptionRow): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
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
 * A first copy also asserts the org row's absence, and a delta asserts it still
 * belongs to this source — so two runs racing produce one loser rather than two
 * winners, and neither can overwrite a row the application wrote.
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
          : {
              ConditionExpression: '#rekeyedFrom = :source',
              ExpressionAttributeNames: { '#rekeyedFrom': REKEY_ATTRIBUTES.from },
              ExpressionAttributeValues: { ':source': { S: plan.source.pk } },
            }),
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

/**
 * Remove one copied org row.
 *
 * Conditional on the row still being a copy of the source the revert read, so a
 * row the application wrote since — or a copy of a different legacy row — is
 * left alone. The legacy row is untouched by both directions: the backfill never
 * deleted it, which is what makes the revert a delete and not a restore.
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
      ['  Re-copy (the source changed since the last copy)', counts.deltas],
      ['  Already copied by an earlier run (skipped)', counts.alreadyCopiedByBackfill],
      [
        '  Already keyed to the org by the application (skipped)',
        counts.alreadyCopiedByApplication,
      ],
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
    resolved.set(
      stripPrefix(org.trim(), BillingKeys.orgPkPrefix()),
      stripPrefix(user.trim(), BillingKeys.legacyPkPrefix()),
    );
  }

  return resolved;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
