// Dispositioning the legacy rows that carry no `orgId`.
//
// These are the one class `--verify` cannot pass on its own: there is no org to
// key them to, so an operator opens each customer in Stripe and either stamps
// the attribute by hand or records that nothing is behind it. The recorded ones
// are named on `--accept-orgless`.
//
// AN ACCEPTANCE NAMES A ROW AND THE STATE IT WAS IN. The runbook's procedure is
// "is there a live subscription in Stripe?", and the answer is only true of the
// row as the operator read it: billing activation and the Stripe webhook both
// write these rows through the legacy key alone — a row with no `orgId` gets no
// org twin from either — so a row accepted as residue on Monday can be a paying
// account by the time the gate runs. A key-only acceptance passes it anyway, and
// the flip then takes that subscription away. So the token carries `updatedAt`
// and the subscription the operator saw, and the check fails when either moved.

import { BillingKeys } from './billing-rekey.ts';
import type { SubscriptionRow } from './billing-rekey.ts';

/** What the token writes for an attribute the row does not carry. */
const ABSENT = '-';

const FIELD_SEPARATOR = '@';

/** One row an operator dispositioned, with the state they dispositioned. */
export interface OrglessAcceptance {
  pk: string;
  updatedAt: string;
  subscriptionId: string;
}

/**
 * The token the report prints for a row and `--accept-orgless` takes back.
 *
 * `pk@updatedAt@subscriptionId`, because the operator's input is a copy-paste of
 * the report's own line. `@` appears in neither an ISO timestamp nor a Stripe id,
 * and the two state fields are read off the end, so a userId that contains one
 * still parses.
 */
export function orglessToken(row: SubscriptionRow): string {
  return [row.pk, row.updatedAt ?? ABSENT, row.subscriptionId ?? ABSENT].join(FIELD_SEPARATOR);
}

export interface ParsedAcceptances {
  accepted: Map<string, OrglessAcceptance>;
  /** Entries that named no state, or named one row twice. Nothing is verified until these are fixed. */
  malformed: string[];
}

/**
 * Parse `--accept-orgless`, which is one token per row.
 *
 * An entry that carries no state is refused rather than read as a key: it is
 * either a list from before this format or a hand-typed pk, and both mean the
 * row was signed off without anybody recording what they signed off.
 */
export function parseAcceptedOrgless(value: string | undefined): ParsedAcceptances {
  const accepted = new Map<string, OrglessAcceptance>();
  const malformed: string[] = [];

  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const acceptance = parseOne(trimmed);
    if (!acceptance) {
      malformed.push(
        `${trimmed} — expected <CUSTOMER#userId>@<updatedAt>@<subscriptionId>, with ${ABSENT} for an ` +
          'attribute the row does not carry. Copy the token the report prints for the row',
      );
      continue;
    }
    if (accepted.has(acceptance.pk)) {
      malformed.push(`${acceptance.pk} — named twice, in two different states`);
      continue;
    }
    accepted.set(acceptance.pk, acceptance);
  }

  return { accepted, malformed };
}

function parseOne(entry: string): OrglessAcceptance | undefined {
  const last = entry.lastIndexOf(FIELD_SEPARATOR);
  if (last < 0) return undefined;
  const first = entry.lastIndexOf(FIELD_SEPARATOR, last - 1);
  if (first < 0) return undefined;

  const key = entry.slice(0, first);
  const updatedAt = entry.slice(first + 1, last);
  const subscriptionId = entry.slice(last + 1);
  if (key.length === 0 || updatedAt.length === 0 || subscriptionId.length === 0) return undefined;

  return {
    pk: key.startsWith(BillingKeys.legacyPkPrefix())
      ? key
      : `${BillingKeys.legacyPkPrefix()}${key}`,
    updatedAt,
    subscriptionId,
  };
}

/** Every orgless row weighed against the acceptance naming it, if there is one. */
export interface OrglessDispositions {
  /** Rows nobody has dispositioned, as the tokens an operator would paste back. */
  undispositioned: string[];
  /** Rows whose acceptance still describes them. */
  accepted: string[];
  /** Rows that changed after they were accepted — the acceptance no longer says anything true. */
  moved: string[];
  /** Acceptances naming a row that is no longer one of these. */
  stale: string[];
}

export function dispositionOrgless(
  orglessRows: readonly SubscriptionRow[],
  acceptances: ReadonlyMap<string, OrglessAcceptance>,
): OrglessDispositions {
  const dispositions: OrglessDispositions = {
    undispositioned: [],
    accepted: [],
    moved: [],
    stale: [],
  };

  for (const row of orglessRows) {
    const acceptance = acceptances.get(row.pk);
    if (!acceptance) {
      dispositions.undispositioned.push(orglessToken(row));
    } else if (orglessToken(row) === tokenOf(acceptance)) {
      dispositions.accepted.push(orglessToken(row));
    } else {
      dispositions.moved.push(
        `${row.pk} — accepted as ${tokenOf(acceptance)}, now ${orglessToken(row)}`,
      );
    }
  }

  const rows = new Set(orglessRows.map((row) => row.pk));
  for (const pk of acceptances.keys()) {
    if (!rows.has(pk)) dispositions.stale.push(pk);
  }

  return dispositions;
}

function tokenOf(acceptance: OrglessAcceptance): string {
  return [acceptance.pk, acceptance.updatedAt, acceptance.subscriptionId].join(FIELD_SEPARATOR);
}
