#!/usr/bin/env node

// Usage: ./bin/set-manual-billing.ts --stage <name> --org-id <orgId> [--revert] [--execute]
//
// Moves an org onto manual billing: a sales agreement invoiced by hand, outside
// Stripe. The org's BillingTable row gets `subscriptionStatus = manual`, which
// gives it full access whatever its Stripe customer or leftover trial
// subscription does next. Nothing in Stripe is changed.
//
// --revert ends manual billing the way a lapsed subscription ends: the row
// enters the paid grace period, the grace-period enforcer write-locks the
// tenants and disables them when it ends, and the customer can pay by card in
// the meantime.
//
// The write only touches the billing row. An org that was in a grace period or
// canceled may still have write-locked or disabled tenants, and the run warns
// when it was; unlock those by hand.
//
// DRY RUN BY DEFAULT; --execute writes. The write is conditioned on the status
// the run read, so a row a Stripe event changed in between is left alone.
//
//   ./bin/set-manual-billing.ts --stage production --org-id <orgId>
//   ./bin/set-manual-billing.ts --stage production --org-id <orgId> --execute
//
// Table names come from `sst state export --stage` and AWS calls use your
// ambient credentials.

import { parseCli } from './lib/args.ts';

const cli = parseCli({
  script: './bin/set-manual-billing.ts',
  flags: ['--revert'],
  options: ['--org-id'],
  help: [
    '--org-id <orgId>  Required. The org to move onto manual billing.',
    '--revert          Move the org off manual billing into the paid grace period.',
  ],
  runbook: 'bin/README.md',
});

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { SubscriptionRecord } from '@filone/backend/src/lib/dynamo-records.ts';
import { SubscriptionKeys } from '@filone/backend/src/lib/subscription-store.ts';
import { decodeRow, text } from './lib/dynamo.ts';
import { planManualBilling } from './lib/manual-billing.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';

const orgId = cli.option('--org-id');
if (!orgId) {
  console.error('--org-id is required. Run with --help for usage.');
  process.exit(1);
}
const mode = cli.flag('--revert') ? 'revert' : 'set';

const tables = resolveStageTables(cli.stage, { BillingTable: '::BillingTableTable' });
assertStageResources(cli.stage, tables);

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });
const key = { pk: { S: SubscriptionKeys.orgPk(orgId) }, sk: { S: SubscriptionKeys.sk() } };

const { Item } = await dynamo.send(
  new GetItemCommand({ TableName: tables.BillingTable, Key: key, ConsistentRead: true }),
);
const row = Item ? decodeRow<SubscriptionRecord>(Item) : undefined;

console.log(`${cli.execute ? 'EXECUTE' : 'DRY-RUN'} — ${mode} manual billing`);
console.log(`  stage:  ${cli.stage} (${awsRegion})`);
console.log(`  table:  ${tables.BillingTable}`);
console.log(`  org:    ${orgId}`);
console.log(`  status: ${text(row?.subscriptionStatus) ?? '(none)'}`);
console.log('');

const plan = planManualBilling({
  mode,
  row: row && { subscriptionStatus: row.subscriptionStatus },
  now: new Date(),
});
if (!plan.ok) {
  console.error(`Refused: ${plan.refusal} Nothing was written.`);
  process.exit(1);
}

const { update, warnings } = plan.value;
console.log(`  ${update.UpdateExpression}`);
console.log(`  if ${update.ConditionExpression}`);
for (const warning of warnings) console.log(`\nWARNING: ${warning}`);
console.log('');

if (!cli.execute) {
  console.log('Dry run only — nothing was written. Re-run with --execute to apply.');
  process.exit(0);
}

try {
  await dynamo.send(new UpdateItemCommand({ TableName: tables.BillingTable, Key: key, ...update }));
} catch (err) {
  if (err instanceof ConditionalCheckFailedException) {
    console.error(
      'Refused: the row changed since it was read, or account teardown has scrubbed it. Nothing was written.',
    );
    process.exit(1);
  }
  throw err;
}
console.log('Done.');
