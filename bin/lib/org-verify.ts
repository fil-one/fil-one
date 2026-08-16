// The checks behind `./convert-orgs-to-orgtable.ts --verify`: what has to be
// true of both tables before the enforcement PR merges.
//
// An anomaly org is an account whose membership the conversion could not
// decide, and every anomaly still holds its legacy `MEMBER#` row in
// UserInfoTable — a table enforcement never reads. The moment enforcement
// deploys, those users have no membership row and are locked out. So an
// anomaly fails verification until an operator has looked at that org and said
// so by name: `--accept-anomalies ORG#…,ORG#…` records the disposition, the
// report echoes it, and anything not on the list is a FAIL.
//
// The legacy rows themselves stay: deleting one would destroy the only
// evidence of what the org held. What has to be true is that every row still
// standing belongs to an org somebody has already looked at.
//
// Everything here is a function of what the scans already collected, so
// `--verify` re-reads the same two tables the conversion does and decides from
// the same classification — no second query language, no table names typed by
// hand.

import { OrgKeys, summarizePlans } from './org-conversion.ts';
import type { AnomalyPlan, OrgPlan, OrgState, PlanCounts, ScanCounts } from './org-conversion.ts';

/** How many rows a passing check enumerates before it summarizes the rest. */
const LISTED_OFFENDERS = 50;

export interface VerifyCheck {
  name: string;
  pass: boolean;
  /** What was found, pass or fail — this is the line an operator records. */
  detail: string;
  /** The orgs behind the finding, named so a failure can be acted on directly. */
  offenders: string[];
  /** Dispositions the operator passed that this check honoured, echoed under the detail. */
  accepted?: string[];
}

/**
 * Normalize one `--accept-anomalies` entry to a bare org id.
 *
 * The ids an operator has in front of them are the report's `ORG#{orgId}`
 * lines, so both that form and the bare id are accepted — copying a line out of
 * the output is the expected way to build the list.
 */
export function parseAcceptedAnomalies(value: string | undefined): Set<string> {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry.startsWith(OrgKeys.orgPkPrefix()) ? entry.slice(OrgKeys.orgPkPrefix().length) : entry,
    );
  return new Set(entries);
}

export function verifyConversion(
  states: readonly OrgState[],
  plans: readonly OrgPlan[],
  scan: ScanCounts,
  acceptedAnomalies: ReadonlySet<string> = new Set(),
): VerifyCheck[] {
  const counts = summarizePlans(plans);
  const planByOrg = new Map(plans.map((plan) => [plan.orgId, plan]));

  const convertible = plans.filter(
    (plan) => plan.kind === 'convert' && plan.origin === 'member-row',
  );
  const repairable = plans.filter(
    (plan) => plan.kind === 'convert' && plan.origin === 'org-profile',
  );
  const pendingDeletes = plans.filter(
    (plan) => plan.kind === 'already-converted' && plan.legacyRowPending,
  );

  const withLegacyRows = states.filter((state) => state.legacyMembers.length > 0);
  const legacyOnNonAnomaly = withLegacyRows.filter(
    (state) => planByOrg.get(state.orgId)?.kind !== 'anomaly',
  );

  const memberWithoutMeta = states.filter(
    (state) => state.orgTableMemberUserIds.length > 0 && !state.hasMeta,
  );
  const metaWithoutMember = states.filter(
    (state) => state.hasMeta && state.orgTableMemberUserIds.length === 0,
  );
  const unexplainedMeta = metaWithoutMember.filter((state) => {
    const plan = planByOrg.get(state.orgId);
    return plan?.kind !== 'anomaly' || plan.reason !== 'membership-removed';
  });

  return [
    {
      name: 'No org is still convertible',
      pass: convertible.length === 0,
      detail: `${convertible.length} orgs would convert from a legacy MEMBER# row`,
      offenders: convertible.map((plan) => OrgKeys.orgPk(plan.orgId)),
    },
    {
      name: 'No org is still repairable',
      pass: repairable.length === 0,
      detail: `${repairable.length} orgs would be repaired from PROFILE.createdBy`,
      offenders: repairable.map((plan) => OrgKeys.orgPk(plan.orgId)),
    },
    {
      name: 'No converted org still holds its legacy row',
      pass: pendingDeletes.length === 0,
      detail: `${pendingDeletes.length} converted orgs have a legacy MEMBER# row left to delete`,
      offenders: pendingDeletes.map((plan) => OrgKeys.orgPk(plan.orgId)),
    },
    {
      name: 'Every remaining legacy MEMBER# row belongs to an anomaly',
      pass: legacyOnNonAnomaly.length === 0,
      detail: `${scan.legacyMemberRows} legacy MEMBER# rows remain, on ${withLegacyRows.length} orgs; ${legacyOnNonAnomaly.length} of those orgs are not anomalies`,
      offenders: withLegacyRows.map((state) =>
        describeLegacyRow(state, planByOrg.get(state.orgId)),
      ),
    },
    {
      name: 'Membership rows and inverse items agree',
      pass: scan.orgTableMemberRows === scan.orgTableInverseRows,
      detail: `${scan.orgTableMemberRows} MEMBER# rows, ${scan.orgTableInverseRows} MEMBERSHIP# inverse items`,
      offenders: [],
    },
    {
      name: 'Every org with a membership has its META counter',
      pass: memberWithoutMeta.length === 0,
      detail: `${scan.orgTableMetaRows} META rows for ${scan.orgTableMemberRows} memberships; ${memberWithoutMeta.length} memberships have none`,
      offenders: memberWithoutMeta.map((state) => OrgKeys.orgPk(state.orgId)),
    },
    {
      name: 'Every META without a membership is a removed membership',
      pass: unexplainedMeta.length === 0,
      detail: `${metaWithoutMember.length} orgs hold META with no membership; ${unexplainedMeta.length} are not classified as membership-removed`,
      offenders: unexplainedMeta.map((state) => OrgKeys.orgPk(state.orgId)),
    },
    anomalyCheck(plans, counts, acceptedAnomalies),
  ];
}

/**
 * Fail-closed on anomalies, because an anomaly org's users have no OrgTable
 * membership and enforcement reads nothing else: shipping one locks that
 * account out. Passing requires an operator to have named the org on
 * `--accept-anomalies` after looking at it, and every acceptance is carried
 * into the report so a PASS says what was signed off.
 */
function anomalyCheck(
  plans: readonly OrgPlan[],
  counts: PlanCounts,
  acceptedAnomalies: ReadonlySet<string>,
): VerifyCheck {
  const anomalies = plans.filter((plan): plan is AnomalyPlan => plan.kind === 'anomaly');
  const accepted = anomalies.filter((plan) => acceptedAnomalies.has(plan.orgId));
  const undispositioned = anomalies.filter((plan) => !acceptedAnomalies.has(plan.orgId));
  const anomalyOrgIds = new Set(anomalies.map((plan) => plan.orgId));
  const stale = [...acceptedAnomalies].filter((orgId) => !anomalyOrgIds.has(orgId));

  return {
    name: 'Every anomaly has been dispositioned',
    pass: undispositioned.length === 0,
    detail:
      `${counts.anomalies} anomalies of ${counts.orgs} orgs; ${counts.alreadyConverted} converted; ` +
      `${accepted.length} accepted, ${undispositioned.length} undispositioned`,
    offenders: undispositioned.map(describeAnomaly),
    accepted: [
      ...accepted.map(describeAnomaly),
      ...stale.map((orgId) => `${OrgKeys.orgPk(orgId)} — no longer an anomaly`),
    ],
  };
}

/** An anomaly as the report names it: the org, why it is one, and what was found. */
function describeAnomaly(plan: AnomalyPlan): string {
  return `${OrgKeys.orgPk(plan.orgId)} [${plan.reason}] ${plan.detail}`;
}

function describeLegacyRow(state: OrgState, plan: OrgPlan | undefined): string {
  const members = state.legacyMembers.map((member) => OrgKeys.memberSk(member.userId)).join(', ');
  const reason =
    plan?.kind === 'anomaly' ? plan.reason : `NOT AN ANOMALY (${plan?.kind ?? 'unclassified'})`;
  return `${OrgKeys.orgPk(state.orgId)} ${members} — ${reason}`;
}

/** The whole verification, as the operator pastes it onto the enforcement PR. */
export function formatVerifyReport(checks: readonly VerifyCheck[]): string {
  const failed = checks.filter((check) => !check.pass);
  const lines: string[] = [];

  for (const check of checks) lines.push(...formatCheck(check));

  lines.push('');
  lines.push(failed.length === 0 ? 'VERIFY: PASS' : `VERIFY: FAIL (${failed.length} checks)`);
  return lines.join('\n');
}

function formatCheck(check: VerifyCheck): string[] {
  const lines = [`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`, `        ${check.detail}`];

  // A passing check lists what it found only when the finding is the point:
  // the remaining legacy rows are the record the enforcement PR wants.
  const listed = check.pass ? check.offenders.slice(0, LISTED_OFFENDERS) : check.offenders;
  for (const offender of listed) lines.push(`          ${offender}`);
  if (check.offenders.length > listed.length) {
    lines.push(`          … and ${check.offenders.length - listed.length} more`);
  }

  // Every acceptance is echoed in full, pass or fail: the operator's
  // dispositions are the part of a PASS somebody has to be able to review.
  if (check.accepted?.length) {
    lines.push(`        accepted by --accept-anomalies (${check.accepted.length}):`);
    for (const entry of check.accepted) lines.push(`          ${entry}`);
  }

  return lines;
}
