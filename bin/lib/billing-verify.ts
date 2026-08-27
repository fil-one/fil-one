// The checks behind `./backfill-billing-to-org.ts --verify`: what has to be true
// of BillingTable before the flip PR merges.
//
// The flip removes the `CUSTOMER#` fallback from every read and the second write
// from every writer, so from that deploy onward the org row is the only row
// anyone looks at. A legacy row with no faithful org twin is an account whose
// subscription vanishes the moment that lands — the guard reads nothing, and
// every gated route answers "not active".
//
// So the gate is not "the copies ran". It is: every legacy row that names an org
// has an org twin, and every twin says the same thing its source does. The rows
// with no `orgId` are the one class that cannot pass on its own — there is no
// org to key them to — so they are dispositioned by name, the same shape as the
// conversion's `--accept-anomalies`.
//
// Everything here is a function of what the scan already collected, so
// `--verify` re-reads the same table the backfill does and decides from the same
// classification — no second query language, no table names typed by hand.

import {
  BillingKeys,
  COMPARED_ATTRIBUTES,
  isKeyable,
  summarizeBillingPlans,
  type BillingAnomalyPlan,
  type BillingPlan,
  type BillingScanCounts,
  type OrgBillingState,
  type SubscriptionRow,
} from './billing-rekey.ts';
import { dispositionOrgless } from './billing-orgless.ts';
import type { OrglessAcceptance, OrglessDispositions } from './billing-orgless.ts';

/** How many rows a passing check enumerates before it summarizes the rest. */
const LISTED_OFFENDERS = 50;

export interface BillingVerifyCheck {
  name: string;
  pass: boolean;
  /** What was found, pass or fail — this is the line an operator records. */
  detail: string;
  /** The rows behind the finding, named so a failure can be acted on directly. */
  offenders: string[];
  /** Dispositions the operator passed that this check honoured, echoed under the detail. */
  accepted?: string[];
}

/** One attribute on which a copy and its source disagree. */
interface Divergence {
  attribute: string;
  source: string;
  copy: string;
}

/** Everything the checks read. One object, because they read all of it together. */
export interface BillingVerifyInput {
  states: readonly OrgBillingState[];
  plans: readonly BillingPlan[];
  scan: BillingScanCounts;
  /** Legacy rows with no `orgId`, which no org state can hold. */
  orglessRows: readonly SubscriptionRow[];
  /** The ones an operator has dispositioned, each bound to the state they read. */
  acceptedOrgless?: ReadonlyMap<string, OrglessAcceptance>;
  /** Rows whose key parsed as neither shape, named. */
  unparsedRows?: readonly string[];
  /** Rows whose `orgId` attribute cannot be half of a key, named. */
  unkeyableOrgIds?: readonly string[];
}

export function verifyBillingRekey({
  states,
  plans,
  scan,
  orglessRows,
  acceptedOrgless = new Map<string, OrglessAcceptance>(),
  unparsedRows = [],
  unkeyableOrgIds = [],
}: BillingVerifyInput): BillingVerifyCheck[] {
  const counts = summarizeBillingPlans(plans);
  const pending = plans.filter((plan) => plan.kind === 'copy');
  const anomalies = plans.filter((plan): plan is BillingAnomalyPlan => plan.kind === 'anomaly');

  const missingTwin = states.filter((state) => state.legacyRows.length > 0 && !state.orgRow);
  const diverged = states.flatMap(describeDivergence);
  // Missing counts as well as wrong: an org row with no `orgId` attribute is
  // invisible to every lifecycle job, which reads the attribute and not the key.
  const mismatchedOrgId = states.filter(
    (state) => state.orgRow && state.orgRow.orgId !== state.orgId,
  );

  const orgless = dispositionOrgless(orglessRows, acceptedOrgless);

  return [
    {
      name: 'No org still has a row to copy',
      pass: pending.length === 0,
      detail: `${counts.firstCopies} orgs would be copied for the first time, ${counts.deltas} re-copied after a source change`,
      offenders: pending.map((plan) => BillingKeys.orgPk(plan.orgId)),
    },
    {
      name: 'Every legacy row that names an org has an org twin',
      pass: missingTwin.length === 0,
      detail: `${scan.legacyRows} legacy rows, of which ${scan.orglessRows} name no org; ${missingTwin.length} orgs have a legacy row and no twin`,
      offenders: missingTwin.map(
        (state) =>
          `${BillingKeys.orgPk(state.orgId)} — ${state.legacyRows.map((row) => row.pk).join(', ')}`,
      ),
    },
    {
      name: 'Every org twin says what its source says',
      pass: diverged.length === 0,
      detail: `${scan.copiedOrgRows} copied org rows; ${diverged.length} disagree with their source`,
      offenders: diverged,
    },
    {
      name: 'Every org row’s orgId attribute matches its key',
      pass: mismatchedOrgId.length === 0,
      detail: `${scan.orgRows} org rows; ${mismatchedOrgId.length} carry an orgId that is missing or not their own`,
      offenders: mismatchedOrgId.map(
        (state) =>
          `${BillingKeys.orgPk(state.orgId)} carries orgId=${state.orgRow?.orgId ?? '(none)'}`,
      ),
    },
    {
      // A key this script's parsers reject is a row it can neither copy nor
      // account for, and the flip deletes the legacy rows regardless. Counting
      // it and moving on is how a row disappears in a migration.
      name: 'Every SUBSCRIPTION row has a key this migration recognizes',
      pass: unparsedRows.length === 0 && unkeyableOrgIds.length === 0,
      detail: `${scan.subscriptionRows} rows matched; ${unparsedRows.length} keys parsed as neither CUSTOMER# nor ORG#, ${unkeyableOrgIds.length} carry an orgId that cannot form a key`,
      offenders: [
        ...unparsedRows.map((pk) => `${pk} — key parses as neither shape`),
        ...unkeyableOrgIds,
      ],
    },
    {
      name: 'No org is claimed by two subscriptions',
      pass: anomalies.length === 0,
      detail: `${anomalies.length} orgs are anomalies of ${counts.orgs} scanned`,
      offenders: anomalies.map(
        (plan) => `${BillingKeys.orgPk(plan.orgId)} [${plan.reason}] ${plan.detail}`,
      ),
    },
    orglessCheck(scan, orgless),
  ];
}

/**
 * The rows whose `orgId` attribute cannot be half of a key, named with their pk.
 *
 * A `#` in the attribute makes `ORG#{orgId}` parse back as something else, so
 * the row would be filed under an org that does not exist and copied to a
 * partition nobody reads.
 */
export function findUnkeyableOrgIds(rows: readonly SubscriptionRow[]): string[] {
  return rows
    .filter((row) => row.orgId !== undefined && !isKeyable(row.orgId))
    .map((row) => `${row.pk} carries orgId=${JSON.stringify(row.orgId)}`);
}

/**
 * Fail-closed on rows with no `orgId`, because the flip is what makes them
 * unreachable: today every lifecycle job skips them and the guard still finds
 * them through the `CUSTOMER#` fallback, and afterwards nothing finds them at
 * all. Passing requires an operator to have named each row after looking at it,
 * and every acceptance is carried into the report so a PASS says what was signed
 * off.
 *
 * A row that moved since it was accepted fails as loudly as one nobody named.
 * The acceptance says "nothing is behind this row"; an `updatedAt` or a
 * subscription that changed afterwards is the row saying otherwise, and the two
 * writers that produce it — billing activation and the Stripe webhook — write a
 * row with no `orgId` through the legacy key alone, so nothing else here notices.
 */
function orglessCheck(scan: BillingScanCounts, orgless: OrglessDispositions): BillingVerifyCheck {
  const { undispositioned, accepted, moved, stale } = orgless;

  return {
    name: 'Every legacy row with no orgId has been dispositioned',
    pass: undispositioned.length === 0 && moved.length === 0,
    detail: `${scan.orglessRows} legacy rows carry no orgId; ${accepted.length} accepted, ${undispositioned.length} undispositioned, ${moved.length} changed since they were accepted`,
    offenders: [...undispositioned, ...moved],
    accepted: [...accepted, ...stale.map((pk) => `${pk} — no longer a row without an orgId`)],
  };
}

/**
 * Where one org's copy disagrees with its source, attribute by attribute.
 *
 * Only the billing state is compared ({@link COMPARED_ATTRIBUTES}): a stale
 * `subscriptionStatus` is the difference between a served customer and a locked
 * one, while the provenance attributes exist on the copy alone by design. A row
 * the application wrote is exempt — it has no source to be faithful to, and its
 * legacy twin was written beside it by the same dual-write.
 */
function describeDivergence(state: OrgBillingState): string[] {
  const { orgRow } = state;
  if (!orgRow?.rekeyedFrom) return [];

  const source = state.legacyRows.find((row) => row.pk === orgRow.rekeyedFrom);
  if (!source) {
    return [
      `${BillingKeys.orgPk(state.orgId)} — copied from ${orgRow.rekeyedFrom}, which no longer exists`,
    ];
  }

  const divergences = compareRows(source, orgRow);
  if (divergences.length === 0) return [];

  const described = divergences
    .map((d) => `${d.attribute}: source=${d.source} copy=${d.copy}`)
    .join('; ');
  return [`${BillingKeys.orgPk(state.orgId)} — copied from ${source.pk}; ${described}`];
}

function compareRows(source: SubscriptionRow, copy: SubscriptionRow): Divergence[] {
  const divergences: Divergence[] = [];

  for (const attribute of COMPARED_ATTRIBUTES) {
    const before = readScalar(source, attribute);
    const after = readScalar(copy, attribute);
    if (before !== after) {
      divergences.push({ attribute, source: before ?? '(absent)', copy: after ?? '(absent)' });
    }
  }

  return divergences;
}

/**
 * One attribute as a comparable string.
 *
 * Only the scalar forms are read, which is all of {@link COMPARED_ATTRIBUTES} —
 * the one structured attribute a subscription row carries is the cached Stripe
 * price, and a stale price snapshot is refreshed by the read path rather than
 * being a reason to fail the gate.
 */
function readScalar(row: SubscriptionRow, attribute: string): string | undefined {
  const value = row.attributes[attribute];
  if (!value) return undefined;
  return value.S ?? value.N ?? (value.BOOL === undefined ? undefined : String(value.BOOL));
}

/** The whole verification, as the operator pastes it onto the flip PR. */
export function formatBillingVerifyReport(checks: readonly BillingVerifyCheck[]): string {
  const failed = checks.filter((check) => !check.pass);
  const lines: string[] = [];

  for (const check of checks) lines.push(...formatCheck(check));

  lines.push('');
  lines.push(failed.length === 0 ? 'VERIFY: PASS' : `VERIFY: FAIL (${failed.length} checks)`);
  return lines.join('\n');
}

function formatCheck(check: BillingVerifyCheck): string[] {
  const lines = [`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`, `        ${check.detail}`];

  // A passing check lists what it found only when the finding is the point: the
  // dispositioned rows are the record the flip PR wants.
  const listed = check.pass ? check.offenders.slice(0, LISTED_OFFENDERS) : check.offenders;
  for (const offender of listed) lines.push(`          ${offender}`);
  if (check.offenders.length > listed.length) {
    lines.push(`          … and ${check.offenders.length - listed.length} more`);
  }

  // Every acceptance is echoed in full, pass or fail: the operator's
  // dispositions are the part of a PASS somebody has to be able to review.
  if (check.accepted?.length) {
    lines.push(`        accepted by --accept-orgless (${check.accepted.length}):`);
    for (const entry of check.accepted) lines.push(`          ${entry}`);
  }

  return lines;
}
