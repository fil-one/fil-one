#!/usr/bin/env node

// Usage: ./bin/revert-billing-backfill.ts --stage <name> [--execute] [--force-unlock]
//
// Reverts ./bin/backfill-billing-to-org.ts: deletes the `ORG#{orgId}/SUBSCRIPTION`
// rows that backfill created. The `CUSTOMER#` rows are untouched, because the
// backfill never deleted them — which is what makes this a delete and not a
// restore, and what makes it safe while the dual-write is deployed: every read
// still falls back to the legacy key.
//
// Scope is defined by the data, not by a record of the run: only org rows
// carrying `rekeyedFrom` are deleted. Rows the application wrote itself — a new
// signup's trial, a first payment-method setup, anything the dual-write created
// at the org key directly — carry no such attribute and are never touched. Those
// rows are live billing state with no legacy row behind them to fall back to.
//
// DRY RUN BY DEFAULT. Pass --execute to apply.
//
// --stage is required and has no default. The run re-execs itself under
// `sst shell --stage <name>`, then asserts the resolved table name carries
// `filone-<stage>-` before reading anything.
//
//   ./bin/revert-billing-backfill.ts --stage staging
//   ./bin/revert-billing-backfill.ts --stage staging --execute
//
// Staging is AWS account 654654381893, production 811430801166. Confirm the stage
// and the table name printed at startup before running with --execute.
//
// ONLY BEFORE THE FLIP. Reach for this while the flip PR is unmerged, so the
// `CUSTOMER#` fallback is still in every read path. After the flip deploys, the
// org row is the only row anyone looks at, and deleting it takes the account's
// subscription with it — reverting billing then means reverting that deploy too.
//
// An --execute run holds the same BillingTable lock row the backfill takes, and
// holds it from before the scan, so neither run can act on a plan the other has
// already changed. --force-unlock drops a lock a crashed run left behind.
//
// There is no DynamoDB PITR/backup, so the per-row log is the only audit trail —
// capture the whole run when running for real:
//   ... --execute 2>&1 | tee revert-billing.log
//
// When to reach for this, and what to check afterwards:
// docs/BillingRekeyRunbook.md.

import { setTimeout as sleep } from 'node:timers/promises';

import { parseCli } from './lib/args.ts';
import { ensureSstShell } from './lib/stage.ts';

const RUNBOOK = 'docs/BillingRekeyRunbook.md';

const cli = parseCli({
  script: './bin/revert-billing-backfill.ts',
  flags: ['--force-unlock'],
  runbook: RUNBOOK,
  help: ['--force-unlock  Drop the run lock a crashed --execute run left behind.'],
});

ensureSstShell(cli.stage, import.meta.filename, cli.argv);

import { Resource } from 'sst';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { decodeRow, scanAll, text, transactWithRetry } from './lib/dynamo.ts';
import { acquireRunLock, BILLING_REKEY_LOCK_PK, forceUnlock } from './lib/run-lock.ts';
import { assertStageResources, awsRegionForStage } from './lib/stage.ts';
import { BillingKeys, buildRevertItem, parseOrgPk } from './lib/billing-rekey.ts';
import { buildRevertScanInput } from './lib/billing-scan.ts';

/** Pause between deletes, so a few thousand transactions stay polite to a shared table. */
const WRITE_DELAY_MS = 50;

const billingTable = Resource.BillingTable.name;

assertStageResources(cli.stage, { BillingTable: billingTable });

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });

if (cli.flag('--force-unlock')) {
  await forceUnlock(dynamo, billingTable, BILLING_REKEY_LOCK_PK);
  process.exit(0);
}

const mode = cli.execute ? 'EXECUTE — ' : 'DRY-RUN — ';
console.log(
  `${mode}Deleting the org rows the billing backfill created (stage="${cli.stage}", region=${awsRegion})`,
);
console.log(`  BillingTable: ${billingTable}`);
console.log('');

/** One copied org row, as the revert reads it back. */
interface CopiedRow {
  orgId: string;
  rekeyedFrom: string;
}

interface RevertRowAttributes {
  pk: string;
  rekeyedFrom: string;
}

const copies: CopiedRow[] = [];
let orgRows = 0;
let applicationRows = 0;

/**
 * Every org row this backfill wrote, and — from the same pass — how many org
 * rows the application wrote itself, because "how many am I leaving alone" is
 * the number an operator wants before deleting anything.
 *
 * What the pass asks the table for, including the consistent read a revert
 * cannot be complete without, is {@link buildRevertScanInput}.
 */
async function scanCopiedRows(): Promise<void> {
  const items = scanAll(dynamo, buildRevertScanInput(billingTable));

  for await (const item of items) {
    orgRows++;
    const row = decodeRow<RevertRowAttributes>(item);
    const orgId = parseOrgPk(text(row.pk) ?? '');
    const rekeyedFrom = text(row.rekeyedFrom);

    if (!orgId) continue;
    if (!rekeyedFrom) {
      applicationRows++;
      continue;
    }
    copies.push({ orgId, rekeyedFrom });
  }

  copies.sort((a, b) => a.orgId.localeCompare(b.orgId));
}

const outcomes = { deleted: 0, changed: 0 };

// Held across the scan as well as the deletes, the way the backfill holds it.
// A backfill that commits copies while this run is scanning writes rows the
// plan does not contain, and the run then deletes the older inventory and
// prints a count an operator reads as the whole revert. Holding the lock from
// before the read makes the plan and the deletes describe one table.
const lock = cli.execute
  ? await acquireRunLock(dynamo, billingTable, {
      script: 'revert-billing-backfill.ts',
      stage: cli.stage,
      lockPk: BILLING_REKEY_LOCK_PK,
    })
  : undefined;

try {
  await scanCopiedRows();

  console.log(`Org SUBSCRIPTION rows: ${orgRows}`);
  console.log(`  Written by the backfill (deletable): ${copies.length}`);
  console.log(`  Written by the application (kept):   ${applicationRows}`);
  console.log('');
  if (applicationRows > 0) {
    console.log('The application-written rows are live billing state with no legacy row behind');
    console.log('them. They are never deleted here — see the runbook for why.');
    console.log('');
  }
  console.log(`Deletes ${copies.length} org rows. No CUSTOMER# row is touched.`);
  console.log('');

  for (const copy of copies) {
    const label = `${BillingKeys.orgPk(copy.orgId)} (copied from ${copy.rekeyedFrom})`;

    if (!cli.execute) {
      console.log(`  [dry-run] DELETE ${label}`);
      continue;
    }

    const conditionFailed = await transactWithRetry(
      dynamo,
      buildRevertItem(copy.orgId, copy.rekeyedFrom, billingTable),
      label,
    );

    if (conditionFailed) {
      // Either the org row changed between the scan and the delete — re-copied
      // from a different source, or replaced by the application — or its legacy
      // row is gone or now names a different org, which means there is no
      // fallback to revert to and deleting would take the account's
      // subscription with it.
      outcomes.changed++;
      console.log(
        `  KEPT ${label} — the org row changed since the scan, or its CUSTOMER# row is gone or names another org`,
      );
    } else {
      outcomes.deleted++;
      console.log(`  DELETED ${label}`);
    }
    await sleep(WRITE_DELAY_MS);
  }
} finally {
  await lock?.release();
}

console.log('');
if (cli.execute) {
  console.log(`Deleted:                                     ${outcomes.deleted}`);
  console.log(`Kept (changed since the scan, or no fallback):${outcomes.changed}`);
  console.log(`Application-written rows (kept):              ${applicationRows}`);
  console.log('');
  console.log('Every read still falls back to the CUSTOMER# row while the flip is unmerged,');
  console.log(`so the reverted accounts keep working. See ${RUNBOOK}.`);
} else {
  console.log('Dry run only — nothing was written.');
}
console.log('Done.');
