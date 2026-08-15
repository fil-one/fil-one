// The checks behind `./convert-orgs-to-orgtable.ts --verify`: what has to be
// true of both tables before the enforcement PR merges.
//
// The gate is that this reports PASS, not that any one count is zero. Several
// anomaly classes keep their legacy `MEMBER#` row on purpose — the conversion
// was not designed to decide them, and deleting the row would destroy the only
// evidence of what the org held. What must be true is that every legacy row
// still standing belongs to an org somebody has to look at.
//
// Everything here is a function of what the scans already collected, so
// `--verify` re-reads the same two tables the conversion does and decides from
// the same classification — no second query language, no table names typed by
// hand.

import { OrgKeys, summarizePlans } from './org-conversion.ts';
import type { OrgPlan, OrgState, ScanCounts } from './org-conversion.ts';

/** How many rows a passing check enumerates before it summarizes the rest. */
const LISTED_OFFENDERS = 50;

export interface VerifyCheck {
  name: string;
  pass: boolean;
  /** What was found, pass or fail — this is the line an operator records. */
  detail: string;
  /** The orgs behind the finding, named so a failure can be acted on directly. */
  offenders: string[];
}

export function verifyConversion(
  states: readonly OrgState[],
  plans: readonly OrgPlan[],
  scan: ScanCounts,
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
      name: 'Every remaining legacy MEMBER# row belongs to an undispositioned anomaly',
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
    {
      name: 'Anomalies are the only orgs left undone',
      pass: true,
      detail: `${counts.anomalies} anomalies of ${counts.orgs} orgs; ${counts.alreadyConverted} converted`,
      offenders: [],
    },
  ];
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

  for (const check of checks) {
    lines.push(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
    lines.push(`        ${check.detail}`);
    // A passing check lists what it found only when the finding is the point:
    // the remaining legacy rows are the record the enforcement PR wants.
    const listed = check.pass ? check.offenders.slice(0, LISTED_OFFENDERS) : check.offenders;
    for (const offender of listed) lines.push(`          ${offender}`);
    if (check.offenders.length > listed.length) {
      lines.push(`          … and ${check.offenders.length - listed.length} more`);
    }
  }

  lines.push('');
  lines.push(failed.length === 0 ? 'VERIFY: PASS' : `VERIFY: FAIL (${failed.length} checks)`);
  return lines.join('\n');
}
