#!/usr/bin/env node

// Usage: ./bin/backfill-billing-to-org.ts --stage <name> [--execute] [--verify]
//        [--resolve-collisions <orgId=userId,…>] [--accept-orgless <CUSTOMER#…,…>]
//        [--force-unlock]
//
// Copies each BillingTable subscription row from `CUSTOMER#{userId}/SUBSCRIPTION`
// to `ORG#{orgId}/SUBSCRIPTION`, using the row's own `orgId` attribute (IAM M1,
// FIL-1013, ADR §5 phase 2). The dual-write is already deployed, so both keys
// are being written for every account the application touches; this run copies
// the accounts it has not touched.
//
// NOTHING IS DELETED. The legacy row stays after its copy — the flip PR reads
// only the org key, and the `CUSTOMER#` rows go in a dated cleanup step
// afterwards, once the flip has been running without incident.
//
// Per org, one transaction:
//   ORG#{orgId} / SUBSCRIPTION      every attribute of the legacy row, with
//                                   orgId + userId written from the key, and
//                                   rekeyedFrom / rekeyedAt / rekeySourceUpdatedAt
//   CUSTOMER#{userId} / SUBSCRIPTION  a ConditionCheck: `updatedAt` is still
//                                   what this copy claims to carry
//
// The ConditionCheck is the point. Stripe webhooks mutate these rows all day, so
// a copy is only meaningful if the source has not moved since it was read — a
// run that loses the check leaves that org for the next run, which re-reads it.
//
// A source that changes AFTER its copy lands is re-copied: the copy stores the
// source's `updatedAt`, and a mismatch on a later run is a delta. That happens
// when a Stripe object carrying no `metadata.orgId` updates the legacy row alone.
//
// DRY RUN BY DEFAULT. The run prints its full plan — counts, the rows with no
// orgId, the already-copied count, and every anomaly — before it writes
// anything, in both modes. Pass --execute to apply it.
//
// --stage is required and has no default: the target account is a decision, not
// something to inherit from whatever the shell was last used for. The run
// re-execs itself under `sst shell --stage <name>`, then asserts the resolved
// table name carries `filone-<stage>-` before reading anything.
//
//   ./bin/backfill-billing-to-org.ts --stage staging
//   ./bin/backfill-billing-to-org.ts --stage staging --execute
//   ./bin/backfill-billing-to-org.ts --stage production --verify
//
// Staging is AWS account 654654381893, production 811430801166. Confirm the
// stage and the table name printed at startup before running with --execute.
//
// COLLISIONS HALT THE RUN. Several `CUSTOMER#` rows can name one org (a user who
// re-subscribed after cancelling). Rows agreeing on `subscriptionId` describe the
// same Stripe subscription, so the newest is copied and the rest are reported as
// superseded. Rows that DISAGREE are a decision this script cannot make: the ADR
// resolves them in favour of the row whose `subscriptionId` is live in Stripe,
// and nothing here can ask Stripe. The run stops and lists them; an operator
// checks each subscription in the Stripe dashboard and names the winner:
//
//   ./bin/backfill-billing-to-org.ts --stage production \
//     --resolve-collisions ORG#8f3c…=CUSTOMER#a1b2…
//
// --verify re-derives the classification and prints PASS/FAIL per check — the
// gate the flip PR merges on. It writes nothing. Legacy rows with no `orgId` fail
// it until each is named on --accept-orgless, because the flip is what makes them
// unreachable.
//
// An --execute run holds a lock row in BillingTable so this script and its revert
// can never run at once. --force-unlock drops a lock a crashed run left behind.
//
// There is no DynamoDB PITR/backup, so the per-org log is the only audit trail —
// capture the whole run when running for real:
//   ... --execute 2>&1 | tee backfill-billing.log
//
// Preconditions, verification, the cleanup step, and the revert procedure:
// docs/BillingRekeyRunbook.md. The revert is ./bin/revert-billing-backfill.ts.

import { setTimeout as sleep } from 'node:timers/promises';

import { parseCli } from './lib/args.ts';
import { ensureSstShell } from './lib/stage.ts';

const RUNBOOK = 'docs/BillingRekeyRunbook.md';

const cli = parseCli({
  script: './bin/backfill-billing-to-org.ts',
  flags: ['--verify', '--force-unlock'],
  options: ['--resolve-collisions', '--accept-orgless'],
  runbook: RUNBOOK,
  help: [
    '--verify        Re-check the table and print PASS/FAIL. Writes nothing.',
    '--resolve-collisions <orgId=userId,…>',
    '                For an org whose legacy rows name different subscriptions:',
    '                the row that is live in Stripe. Check the dashboard first.',
    '--accept-orgless <CUSTOMER#…,…>',
    '                With --verify: the legacy rows with no orgId an operator has',
    '                dispositioned. Rows not named here fail verification.',
    '--force-unlock  Drop the run lock a crashed --execute run left behind.',
  ],
});

ensureSstShell(cli.stage, import.meta.filename, cli.argv);

import { Resource } from 'sst';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { decodeRow, scanAll, text, transactWithRetry } from './lib/dynamo.ts';
import { acquireRunLock, BILLING_REKEY_LOCK_PK, forceUnlock } from './lib/run-lock.ts';
import { assertStageResources, awsRegionForStage } from './lib/stage.ts';
import {
  BillingKeys,
  buildCopyTransactItems,
  classifyOrgBilling,
  formatAppliedResolutions,
  formatBillingPlanReport,
  isKeyable,
  parseLegacyPk,
  parseOrgPk,
  parseResolvedCollisions,
  unkeyableOrgAnomalies,
  validateResolvedCollisions,
} from './lib/billing-rekey.ts';
import type {
  BillingPlan,
  BillingScanCounts,
  CopyPlan,
  OrgBillingState,
  SubscriptionRow,
} from './lib/billing-rekey.ts';
import {
  findUnkeyableOrgIds,
  formatBillingVerifyReport,
  verifyBillingRekey,
} from './lib/billing-verify.ts';

/** Pause between orgs that write, so a few thousand transactions stay polite to a shared table. */
const WRITE_DELAY_MS = 50;

const billingTable = Resource.BillingTable.name;

assertStageResources(cli.stage, { BillingTable: billingTable });

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });

const verify = cli.flag('--verify');
const execute = cli.execute && !verify;
const resolved = parseResolvedCollisions(cli.option('--resolve-collisions'));
const acceptedOrgless = parseAcceptedOrgless(cli.option('--accept-orgless'));

const scan: BillingScanCounts = {
  subscriptionRows: 0,
  legacyRows: 0,
  orgRows: 0,
  copiedOrgRows: 0,
  unparsedRows: 0,
  orglessRows: 0,
};

const orgs = new Map<string, OrgBillingState>();
/** Legacy rows with no `orgId` — there is no org to file them under. */
const orglessRows: string[] = [];
/** Legacy rows whose `orgId` cannot form a key — an org to copy to that does not exist. */
const unkeyableRows: SubscriptionRow[] = [];
/** Keys that parse as neither shape. Named, because a counted row is a row nobody looks at. */
const unparsedRows: string[] = [];
/** Every row the scan read, for the checks that are about keys rather than orgs. */
const allRows: SubscriptionRow[] = [];

function orgState(orgId: string): OrgBillingState {
  const existing = orgs.get(orgId);
  if (existing) return existing;
  const created: OrgBillingState = { orgId, legacyRows: [] };
  orgs.set(orgId, created);
  return created;
}

/** The attributes the classification reads by name; the rest travel in the copy. */
interface BillingRowAttributes {
  pk: string;
  orgId: string;
  subscriptionId: string;
  updatedAt: string;
  rekeyedFrom: string;
  rekeySourceUpdatedAt: string;
}

/**
 * One pass over BillingTable collects every subscription row.
 *
 * No `ProjectionExpression`: the copy carries every attribute the source holds,
 * so the whole row is what the run needs. The filter is the sort key alone —
 * webhook idempotency rows and usage reports live under other sort keys and are
 * never matched.
 */
async function scanBillingTable(): Promise<void> {
  // ConsistentRead: this scan is what `--verify` gates the flip on, and an
  // eventually-consistent miss reads as "no legacy row for that org" — the exact
  // shape of the failure the gate exists to catch.
  const items = scanAll(dynamo, {
    TableName: billingTable,
    FilterExpression: 'sk = :subscription',
    ExpressionAttributeValues: { ':subscription': { S: BillingKeys.subscriptionSk() } },
    ConsistentRead: true,
  });

  for await (const item of items) {
    scan.subscriptionRows++;
    collectRow(item);
  }
}

function collectRow(item: Record<string, AttributeValue>): void {
  const decoded = decodeRow<BillingRowAttributes>(item);
  const pk = text(decoded.pk) ?? '';
  const row: SubscriptionRow = {
    pk,
    attributes: item,
    ...(text(decoded.orgId) ? { orgId: text(decoded.orgId) } : {}),
    ...(text(decoded.subscriptionId) ? { subscriptionId: text(decoded.subscriptionId) } : {}),
    ...(text(decoded.updatedAt) ? { updatedAt: text(decoded.updatedAt) } : {}),
    ...(text(decoded.rekeyedFrom) ? { rekeyedFrom: text(decoded.rekeyedFrom) } : {}),
    ...(text(decoded.rekeySourceUpdatedAt)
      ? { rekeySourceUpdatedAt: text(decoded.rekeySourceUpdatedAt) }
      : {}),
  };

  allRows.push(row);

  const orgIdFromKey = parseOrgPk(pk);
  if (orgIdFromKey) {
    scan.orgRows++;
    if (row.rekeyedFrom) scan.copiedOrgRows++;
    orgState(orgIdFromKey).orgRow = row;
    return;
  }

  if (!parseLegacyPk(pk)) {
    scan.unparsedRows++;
    unparsedRows.push(pk);
    return;
  }

  scan.legacyRows++;
  if (!row.orgId) {
    scan.orglessRows++;
    orglessRows.push(pk);
    return;
  }

  // An orgId with a `#` in it names no org this run can key to, so it is held
  // out of the grouping rather than copied to `ORG#a#b` and reported by the
  // NEXT run's --verify — the order that has the migration failing itself on a
  // row it wrote.
  if (!isKeyable(row.orgId)) {
    unkeyableRows.push(row);
    return;
  }

  orgState(row.orgId).legacyRows.push(row);
}

/**
 * Re-read one org's rows consistently, so the plan a write acts on is not the
 * one the scan produced minutes ago.
 *
 * The transaction's own conditions are what make the write safe; this read is
 * what makes the LOG honest — the line printed for an org names the source
 * `updatedAt` the write actually carried.
 */
async function rereadOrg(state: OrgBillingState): Promise<OrgBillingState> {
  const reread: OrgBillingState = { orgId: state.orgId, legacyRows: [] };

  for (const row of state.legacyRows) {
    const fresh = await readRow(row.pk);
    if (fresh) reread.legacyRows.push(fresh);
  }
  const orgRow = await readRow(BillingKeys.orgPk(state.orgId));
  if (orgRow) reread.orgRow = orgRow;

  return reread;
}

async function readRow(pk: string): Promise<SubscriptionRow | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: billingTable,
      Key: { pk: { S: pk }, sk: { S: BillingKeys.subscriptionSk() } },
      ConsistentRead: true,
    }),
  );
  if (!Item) return undefined;

  const decoded = decodeRow<BillingRowAttributes>(Item);
  return {
    pk,
    attributes: Item,
    ...(text(decoded.orgId) ? { orgId: text(decoded.orgId) } : {}),
    ...(text(decoded.subscriptionId) ? { subscriptionId: text(decoded.subscriptionId) } : {}),
    ...(text(decoded.updatedAt) ? { updatedAt: text(decoded.updatedAt) } : {}),
    ...(text(decoded.rekeyedFrom) ? { rekeyedFrom: text(decoded.rekeyedFrom) } : {}),
    ...(text(decoded.rekeySourceUpdatedAt)
      ? { rekeySourceUpdatedAt: text(decoded.rekeySourceUpdatedAt) }
      : {}),
  };
}

type ApplyOutcome = 'copied' | 'raced' | 'skipped';

/**
 * Copy one org's row.
 *
 * A cancelled transaction is read for what it says. A failed condition means the
 * data moved under the run: either the source was updated since it was read (the
 * ConditionCheck), or another writer created the org row first (the Put). Neither
 * is an error and neither may be forced — the org is left for the next run, which
 * re-reads it and copies whatever is there then. Throttling and transaction
 * conflicts are retried; anything else stops the run.
 */
async function applyCopy(plan: CopyPlan, now: string): Promise<ApplyOutcome> {
  const label = `${BillingKeys.orgPk(plan.orgId)} <- ${plan.source.pk}`;

  const conditionFailed = await transactWithRetry(
    dynamo,
    buildCopyTransactItems(plan, billingTable, now),
    label,
  );

  if (conditionFailed) {
    console.log(
      `  RACED ${label} — the rows moved between the read and the write (${conditionFailed.join(',')}); left for the next run`,
    );
    return 'raced';
  }

  return 'copied';
}

/** One org's copy, as the audit log records it. */
function describe(plan: CopyPlan): string {
  const source =
    plan.reason === 'first-copy'
      ? `updatedAt=${plan.sourceUpdatedAt ?? '(none)'}`
      : `updatedAt=${plan.sourceUpdatedAt ?? '(none)'} (copy carried ${plan.copiedUpdatedAt ?? '(none)'})`;
  const superseded = plan.supersedes?.length ? ` superseding ${plan.supersedes.join(', ')}` : '';
  return `${BillingKeys.orgPk(plan.orgId)} <- ${plan.source.pk} ${source}${superseded}`;
}

function parseAcceptedOrgless(value: string | undefined): Set<string> {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry.startsWith(BillingKeys.legacyPkPrefix())
        ? entry
        : `${BillingKeys.legacyPkPrefix()}${entry}`,
    );
  return new Set(entries);
}

/**
 * The run, in one function so every exit is a `return`.
 *
 * `process.exit` truncates whatever the process has buffered, and the runbook
 * has every run piped through `tee` — so the last lines of the report, the ones
 * naming what an operator has to act on, were the ones most likely to be lost.
 * `process.exitCode` sets the same status and lets the process end on its own.
 */
async function main(): Promise<void> {
  // A disposition is a statement about what --verify may pass, and nothing else
  // reads it. Accepting it on a run that cannot act on it would let an operator
  // believe rows had been signed off when no check ever saw the list.
  if (acceptedOrgless.size > 0 && !verify) {
    console.error('--accept-orgless applies to --verify only. Nothing was read or written.');
    process.exitCode = 1;
    return;
  }

  if (cli.flag('--force-unlock')) {
    await forceUnlock(dynamo, billingTable, BILLING_REKEY_LOCK_PK);
    return;
  }

  const mode = verify ? 'VERIFY — ' : execute ? 'EXECUTE — ' : 'DRY-RUN — ';
  console.log(
    `${mode}Copying subscription rows to their org key (stage="${cli.stage}", region=${awsRegion})`,
  );
  console.log(`  BillingTable: ${billingTable}`);
  console.log('');

  // The lock is taken BEFORE the scan, not before the writes. A revert that
  // starts while this run is scanning deletes rows the plan already contains,
  // and the plan an operator then approves describes a table that no longer
  // exists. Holding it across the read makes the plan and the writes agree.
  const lock = execute
    ? await acquireRunLock(dynamo, billingTable, {
        script: 'backfill-billing-to-org.ts',
        stage: cli.stage,
        lockPk: BILLING_REKEY_LOCK_PK,
      })
    : undefined;

  try {
    await run();
  } finally {
    await lock?.release();
  }
}

async function run(): Promise<void> {
  await scanBillingTable();

  const states = [...orgs.values()].sort((a, b) => a.orgId.localeCompare(b.orgId));

  // A resolution naming a row nobody scanned is a typo or a stale list, and its
  // failure mode is the confusing one: the org stays unresolved, the run halts
  // on the same collision, and the halt reads as the argument not having been
  // passed at all.
  const badResolutions = validateResolvedCollisions(resolved, states);
  if (badResolutions.length > 0) {
    console.error('--resolve-collisions names rows this scan did not find:');
    for (const problem of badResolutions) console.error(`  ${problem}`);
    console.error('Nothing was written.');
    process.exitCode = 1;
    return;
  }

  const plans: BillingPlan[] = [
    ...states.map((state) => classifyOrgBilling(state, resolved)),
    ...unkeyableOrgAnomalies(unkeyableRows),
  ];

  if (verify) {
    reportVerification(states, plans);
    return;
  }

  console.log(formatBillingPlanReport(scan, plans, orglessRows));
  for (const line of formatAppliedResolutions(resolved, plans)) console.log(line);
  console.log('');

  if (halted(plans)) return;

  const stateByOrg = new Map(states.map((state) => [state.orgId, state]));
  printSummary(plans, await copyEachOrg(plans, stateByOrg));
}

/**
 * The gate the flip PR merges on.
 *
 * It prints the plan as well as the checks: a PASS whose reader cannot see what
 * was classified is a number to paste onto a PR, not evidence. The applied
 * resolutions are part of that — a collision an operator decided is a decision
 * the PASS rests on, and it is nowhere on the org row a later reader can see.
 */
function reportVerification(
  states: readonly OrgBillingState[],
  plans: readonly BillingPlan[],
): void {
  console.log(formatBillingPlanReport(scan, plans, orglessRows));
  for (const line of formatAppliedResolutions(resolved, plans)) console.log(line);
  console.log('');
  const checks = verifyBillingRekey({
    states,
    plans,
    scan,
    orglessRows,
    acceptedOrgless,
    unparsedRows,
    unkeyableOrgIds: findUnkeyableOrgIds(allRows),
  });
  console.log(formatBillingVerifyReport(checks));
  if (checks.some((check) => !check.pass)) process.exitCode = 1;
}

/**
 * Collisions stop the run in BOTH modes, before any write and before the per-org
 * lines. The plan a dry run prints is the plan --execute plays back, and a plan
 * that skips the orgs an operator has not decided about is not the plan.
 */
function halted(plans: readonly BillingPlan[]): boolean {
  const unresolved = plans.filter((plan) => plan.kind === 'anomaly' && plan.reason === 'collision');
  if (unresolved.length === 0) return false;

  console.error(
    `HALTED: ${unresolved.length} orgs are claimed by legacy rows naming different subscriptions.`,
  );
  console.error(
    'Check each subscriptionId in the Stripe dashboard, then name the live row per org:',
  );
  console.error('  --resolve-collisions ORG#<orgId>=CUSTOMER#<userId>,…');
  console.error(`See ${RUNBOOK}. Nothing was written.`);
  process.exitCode = 1;
  return true;
}

/**
 * Every planned copy ends in exactly one of these, which is what makes the
 * closing line an identity rather than a set of numbers that happen to sit near
 * each other. Orgs that never needed a copy were never planned, so they are
 * counted apart from the ones that stopped needing one mid-run.
 */
interface Outcomes {
  copied: number;
  recopied: number;
  raced: number;
  /** Planned, then found not to need a copy when re-read. */
  skippedSince: number;
  /** Never planned: in sync when the table was scanned. */
  alreadyCopied: number;
  anomalies: number;
}

async function copyEachOrg(
  plans: readonly BillingPlan[],
  stateByOrg: ReadonlyMap<string, OrgBillingState>,
): Promise<Outcomes> {
  const outcomes: Outcomes = {
    copied: 0,
    recopied: 0,
    raced: 0,
    skippedSince: 0,
    alreadyCopied: 0,
    anomalies: 0,
  };

  for (const plan of plans) {
    if (plan.kind === 'anomaly') {
      outcomes.anomalies++;
    } else if (plan.kind === 'already-copied') {
      outcomes.alreadyCopied++;
    } else if (!execute) {
      console.log(
        `  [dry-run] ${plan.reason === 'first-copy' ? 'COPY' : 'RE-COPY'} ${describe(plan)}`,
      );
    } else {
      await copyOneOrg(plan, stateByOrg, outcomes);
      await sleep(WRITE_DELAY_MS);
    }
  }

  return outcomes;
}

/**
 * The scan is minutes old by now and Stripe has been writing all along, so the
 * org is re-read and re-classified before the write. An org that stopped needing
 * a copy in the meantime is reported as such rather than copied from a stale
 * read.
 */
async function copyOneOrg(
  plan: CopyPlan,
  stateByOrg: ReadonlyMap<string, OrgBillingState>,
  outcomes: Outcomes,
): Promise<void> {
  const fresh = classifyOrgBilling(await rereadOrg(stateByOrg.get(plan.orgId)!), resolved);
  if (fresh.kind !== 'copy') {
    outcomes.skippedSince++;
    console.log(
      `  SKIPPED ${BillingKeys.orgPk(plan.orgId)} — no longer needs a copy (${fresh.kind === 'anomaly' ? fresh.reason : fresh.origin})`,
    );
    return;
  }

  const outcome = await applyCopy(fresh, new Date().toISOString());
  if (outcome === 'raced') {
    outcomes.raced++;
    return;
  }
  if (fresh.reason === 'first-copy') outcomes.copied++;
  else outcomes.recopied++;
  console.log(`  ${fresh.reason === 'first-copy' ? 'COPIED' : 'RE-COPIED'} ${describe(fresh)}`);
}

function printSummary(plans: readonly BillingPlan[], outcomes: Outcomes): void {
  const planned = plans.filter((plan) => plan.kind === 'copy').length;

  console.log('');
  if (!execute) {
    console.log('Dry run only — nothing was written.');
    console.log('Disposition every anomaly above, then re-run with --execute.');
    console.log('Done.');
    return;
  }

  const written = outcomes.copied + outcomes.recopied;
  console.log(`Copied (first time):                         ${outcomes.copied}`);
  console.log(`Re-copied (the legacy row was newer):        ${outcomes.recopied}`);
  console.log(`Skipped (no longer needed a copy):           ${outcomes.skippedSince}`);
  console.log(`Raced (the rows moved; next run retries):    ${outcomes.raced}`);
  console.log(`Already in sync at scan time (not planned):  ${outcomes.alreadyCopied}`);
  console.log(`Anomalies (untouched):                       ${outcomes.anomalies}`);
  console.log(`Legacy CUSTOMER# rows deleted:               0 (by design)`);
  console.log('');
  console.log(
    `Planned copies ${planned} = ${written} written + ${outcomes.skippedSince} skipped-since + ${outcomes.raced} raced.`,
  );
  console.log('');
  console.log('Now run --verify against the same stage and record its result — the flip PR');
  console.log('merges on a PASS, and any legacy row without an orgId has to be named on');
  console.log(`--accept-orgless to get one. See ${RUNBOOK}.`);
  if (outcomes.raced > 0) {
    console.log('');
    console.log('Rows raced. Re-run --execute until that count is zero, then verify.');
    process.exitCode = 1;
  }
  console.log('Done.');
}

await main();
