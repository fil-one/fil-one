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
  formatBillingPlanReport,
  parseLegacyPk,
  parseOrgPk,
  parseResolvedCollisions,
} from './lib/billing-rekey.ts';
import type {
  BillingPlan,
  BillingScanCounts,
  CopyPlan,
  OrgBillingState,
  SubscriptionRow,
} from './lib/billing-rekey.ts';
import { formatBillingVerifyReport, verifyBillingRekey } from './lib/billing-verify.ts';

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

// A disposition is a statement about what --verify may pass, and nothing else
// reads it. Accepting it on a run that cannot act on it would let an operator
// believe rows had been signed off when no check ever saw the list.
if (acceptedOrgless.size > 0 && !verify) {
  console.error('--accept-orgless applies to --verify only. Nothing was read or written.');
  process.exit(1);
}

if (cli.flag('--force-unlock')) {
  await forceUnlock(dynamo, billingTable, BILLING_REKEY_LOCK_PK);
  process.exit(0);
}

const mode = verify ? 'VERIFY — ' : execute ? 'EXECUTE — ' : 'DRY-RUN — ';
console.log(
  `${mode}Copying subscription rows to their org key (stage="${cli.stage}", region=${awsRegion})`,
);
console.log(`  BillingTable: ${billingTable}`);
console.log('');

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
  const items = scanAll(dynamo, {
    TableName: billingTable,
    FilterExpression: 'sk = :subscription',
    ExpressionAttributeValues: { ':subscription': { S: BillingKeys.subscriptionSk() } },
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

  const orgIdFromKey = parseOrgPk(pk);
  if (orgIdFromKey) {
    scan.orgRows++;
    if (row.rekeyedFrom) scan.copiedOrgRows++;
    orgState(orgIdFromKey).orgRow = row;
    return;
  }

  if (!parseLegacyPk(pk)) {
    scan.unparsedRows++;
    return;
  }

  scan.legacyRows++;
  if (!row.orgId) {
    scan.orglessRows++;
    orglessRows.push(pk);
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

await scanBillingTable();

const states = [...orgs.values()].sort((a, b) => a.orgId.localeCompare(b.orgId));
const stateByOrg = new Map(states.map((state) => [state.orgId, state]));
const plans: BillingPlan[] = states.map((state) => classifyOrgBilling(state, resolved));

if (verify) {
  const checks = verifyBillingRekey({
    states,
    plans,
    scan,
    orglessRows,
    acceptedOrgless,
  });
  console.log(formatBillingVerifyReport(checks));
  process.exit(checks.some((check) => !check.pass) ? 1 : 0);
}

console.log(formatBillingPlanReport(scan, plans, orglessRows));
console.log('');

// Collisions stop the run in BOTH modes, before any write and before the
// per-org lines. The plan a dry run prints is the plan --execute plays back, and
// a plan that skips the orgs an operator has not decided about is not the plan.
const unresolvedCollisions = plans.filter(
  (plan) => plan.kind === 'anomaly' && plan.reason === 'collision',
);
if (unresolvedCollisions.length > 0) {
  console.error(
    `HALTED: ${unresolvedCollisions.length} orgs are claimed by legacy rows naming different subscriptions.`,
  );
  console.error(
    'Check each subscriptionId in the Stripe dashboard, then name the live row per org:',
  );
  console.error('  --resolve-collisions ORG#<orgId>=CUSTOMER#<userId>,…');
  console.error(`See ${RUNBOOK}. Nothing was written.`);
  process.exit(1);
}

const outcomes = {
  copied: 0,
  recopied: 0,
  raced: 0,
  alreadyCopied: 0,
  anomalies: 0,
};

// Held for the whole write phase: the revert deletes the rows this run creates,
// and one landing mid-run would remove a copy this run is about to condition on.
const lock = execute
  ? await acquireRunLock(dynamo, billingTable, {
      script: 'backfill-billing-to-org.ts',
      stage: cli.stage,
      lockPk: BILLING_REKEY_LOCK_PK,
    })
  : undefined;

try {
  for (const plan of plans) {
    if (plan.kind === 'anomaly') {
      outcomes.anomalies++;
      continue;
    }

    if (plan.kind === 'already-copied') {
      outcomes.alreadyCopied++;
      continue;
    }

    if (!execute) {
      console.log(
        `  [dry-run] ${plan.reason === 'first-copy' ? 'COPY' : 'RE-COPY'} ${describe(plan)}`,
      );
      continue;
    }

    // The scan is minutes old by now and Stripe has been writing all along, so
    // the org is re-read and re-classified before the write. An org that stopped
    // needing one in the meantime is reported as such rather than copied from a
    // stale read.
    const fresh = classifyOrgBilling(await rereadOrg(stateByOrg.get(plan.orgId)!), resolved);
    if (fresh.kind !== 'copy') {
      outcomes.alreadyCopied++;
      console.log(
        `  SKIPPED ${BillingKeys.orgPk(plan.orgId)} — no longer needs a copy (${fresh.kind === 'anomaly' ? fresh.reason : fresh.origin})`,
      );
      await sleep(WRITE_DELAY_MS);
      continue;
    }

    const outcome = await applyCopy(fresh, new Date().toISOString());
    if (outcome === 'copied') {
      if (fresh.reason === 'first-copy') outcomes.copied++;
      else outcomes.recopied++;
      console.log(`  ${fresh.reason === 'first-copy' ? 'COPIED' : 'RE-COPIED'} ${describe(fresh)}`);
    } else if (outcome === 'raced') {
      outcomes.raced++;
    }
    await sleep(WRITE_DELAY_MS);
  }
} finally {
  await lock?.release();
}

const planned = summarize();

console.log('');
if (execute) {
  console.log(`Copied (first time):                         ${outcomes.copied}`);
  console.log(`Re-copied (the source had changed):          ${outcomes.recopied}`);
  console.log(`Skipped (already copied, or copied since):   ${outcomes.alreadyCopied}`);
  console.log(`Raced (the rows moved; next run retries):    ${outcomes.raced}`);
  console.log(`Anomalies (untouched):                       ${outcomes.anomalies}`);
  console.log(`Legacy CUSTOMER# rows deleted:               0 (by design)`);
  console.log('');
  console.log(
    `Planned copies (${planned.writes}) = Copied + Re-copied + Skipped-since + Raced (${
      outcomes.copied + outcomes.recopied + outcomes.raced
    } written, ${outcomes.alreadyCopied} skipped).`,
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
} else {
  console.log('Dry run only — nothing was written.');
  console.log('Disposition every anomaly above, then re-run with --execute.');
}
console.log('Done.');

function summarize(): { writes: number } {
  let writes = 0;
  for (const plan of plans) if (plan.kind === 'copy') writes++;
  return { writes };
}
