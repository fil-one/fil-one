// What the backfill does with the second read of an org.
//
// `./backfill-billing-to-org.ts --execute` re-reads each org consistently right
// before it writes, because the scan is minutes old and Stripe has been writing
// all along. That read can say something the scan did not, and what the run does
// with the difference is a decision rather than a detail — hence functions with
// tests rather than branches inside the runner, which nothing can import.
//
// billing-rekey.ts owns the classification these read back; it sits at the
// max-lines cap, so this is a sibling module for the same reason
// ./billing-scan.ts is one.

import { BillingKeys } from './billing-rekey.ts';
import type {
  BillingAnomalyReason,
  BillingPlan,
  CopyPlan,
  OrgBillingState,
  SubscriptionRow,
} from './billing-rekey.ts';

/** One row the re-read found filed under a different org than the scan did. */
export interface RefiledRow {
  pk: string;
  /** The org it names now, or undefined if the attribute is gone. */
  orgId: string | undefined;
}

export interface RereadState {
  state: OrgBillingState;
  refiled: RefiledRow[];
}

/**
 * One org's rows as the second read found them, with the rows that are no longer
 * this org's held out.
 *
 * A row's `orgId` is what files it under an org, and an operator correcting a
 * mis-stamped attribute between the scan and the write is the case this
 * migration's own runbook asks for. Carrying such a row into this org's
 * classification would copy org B's subscription to `ORG#A` — the classification
 * takes the org from the state it is handed, not from the row — and the copy the
 * flip then serves gives A somebody else's billing. Held out, the row is left
 * for the next run, which scans it under the org it names now.
 */
export function rereadOrgState(
  orgId: string,
  legacyRows: readonly SubscriptionRow[],
  orgRow?: SubscriptionRow,
): RereadState {
  const state: OrgBillingState = { orgId, legacyRows: [] };
  const refiled: RefiledRow[] = [];

  for (const row of legacyRows) {
    if (row.orgId === orgId) state.legacyRows.push(row);
    else refiled.push({ pk: row.pk, orgId: row.orgId });
  }
  if (orgRow) state.orgRow = orgRow;

  return { state, refiled };
}

/**
 * What the re-read classification means for the org the run was about to copy.
 *
 * The three outcomes are three different things to tell an operator. An org that
 * stopped needing a copy is the ordinary case the re-read exists to catch. An
 * org that became an ANOMALY — a collision that appeared while the run was
 * working, a row refiled under another org — is a finding: nothing was written
 * for it, nothing will be until somebody looks, and a run that folds it into the
 * skipped count exits zero reporting no anomalies at all.
 */
export type RereadDisposition =
  | { outcome: 'copy'; plan: CopyPlan }
  | { outcome: 'anomaly'; reason: BillingAnomalyReason; message: string }
  | { outcome: 'skipped'; message: string };

export function dispositionReread(plan: BillingPlan): RereadDisposition {
  if (plan.kind === 'copy') return { outcome: 'copy', plan };

  if (plan.kind === 'anomaly') {
    return {
      outcome: 'anomaly',
      reason: plan.reason,
      message: `${BillingKeys.orgPk(plan.orgId)} [${plan.reason}] ${plan.detail}`,
    };
  }

  return {
    outcome: 'skipped',
    message: `${BillingKeys.orgPk(plan.orgId)} — no longer needs a copy (${plan.origin})`,
  };
}
