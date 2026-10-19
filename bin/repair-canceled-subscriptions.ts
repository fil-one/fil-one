#!/usr/bin/env node

// Usage: ./bin/repair-canceled-subscriptions.ts --stage <name> [--execute]
//
// Repairs the billing rows two cancellation bugs left behind, and reports the
// orgs a third one cut short.
//
// REPAIRED: rows Stripe canceled but the table still shows as `active` or
// `past_due` (FIL-1494). A final invoice after cancellation used to revive the
// row, so the tenant stayed unlocked and unbilled. Each such row moves to
// `grace_period` with `canceledAt` set to Stripe's `ended_at` and the 30 days a
// paying org gets counted from it. Most of those deadlines have passed, so the
// grace-period enforcer disables the tenant on its next daily run; the rest it
// write-locks until their deadline.
//
// REPORTED, NOT CHANGED: paid orgs whose cancellation granted 7 days of grace
// instead of 30 (FIL-1460). An upgrade keeps the trial's `trial_end`, and the
// cancellation handler read any `trial_end` as a trial. The report lists each
// org, its deadline, the deadline it should have had, and whether the enforcer
// has already disabled it, so support can decide whether to reach out.
//
// A canceled row no longer says what the org was before, so "paid" is read from
// Stripe: the subscription had a default payment method (Upgrade and
// reactivation attach one), or it never had a trial. A trial that expires
// without a card is canceled by Stripe for having no payment method, so it
// never has one.
//
// DRY RUN BY DEFAULT. The run prints one line per org and the totals, then
// writes only with --execute. Each repair is conditioned on the row's status,
// subscription id and the scrub fence being what the scan read, so a row a
// webhook moved in the meantime is skipped and left for the next run. Repaired
// rows no longer match, so a second run has nothing to do.
//
// Stripe: export a restricted, read-only secret key as STRIPE_API_KEY. The run
// only retrieves subscriptions. (`sst shell` cannot resolve production, so the
// stage's linked key is not available here.) DynamoDB: the table name comes from
// `sst state export`, and every AWS call uses your ambient credentials.
//
//   STRIPE_API_KEY=rk_live_… ./bin/repair-canceled-subscriptions.ts --stage production
//   STRIPE_API_KEY=rk_live_… ./bin/repair-canceled-subscriptions.ts --stage production --execute
//
// There is no DynamoDB PITR, so the printed plan is the only audit trail:
//   ... --execute 2>&1 | tee repair-canceled-subscriptions.log

import { setTimeout as sleep } from 'node:timers/promises';

import { parseCli } from './lib/args.ts';

const cli = parseCli({
  script: './bin/repair-canceled-subscriptions.ts',
  runbook: 'the header of bin/repair-canceled-subscriptions.ts',
});

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import Stripe from 'stripe';
import { decodeRow, scanAll, text } from './lib/dynamo.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';
import { SubscriptionKeys } from '@filone/backend/src/lib/subscription-store.ts';

const PAID_GRACE_DAYS = 30;
const TRIAL_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A 7-day grace period, give or take the slack between `canceledAt` and the clock. */
const SHORT_GRACE_TOLERANCE_MS = 60 * 60 * 1000;
/** Pause between Stripe lookups, well under the read rate limit. */
const STRIPE_DELAY_MS = 50;

const stripeKey = process.env.STRIPE_API_KEY;
if (!stripeKey) {
  console.error('Set STRIPE_API_KEY to a restricted, read-only Stripe secret key.');
  process.exit(1);
}

const { BillingTable: billingTable } = resolveStageTables(cli.stage, {
  BillingTable: '::BillingTableTable',
});
assertStageResources(cli.stage, { BillingTable: billingTable });

const dynamo = new DynamoDBClient({ region: awsRegionForStage(cli.stage) });
const stripe = new Stripe(stripeKey);

interface Row {
  pk: string;
  orgId: string;
  subscriptionId: string;
  subscriptionStatus: string;
  canceledAt?: string;
  gracePeriodEndsAt?: string;
}

interface Repair {
  row: Row;
  canceledAt: string;
  gracePeriodEndsAt: string;
}

interface Report {
  row: Row;
  paidDeadline: string;
  note: string;
}

console.log(
  `Stage: ${cli.stage}  Table: ${billingTable}  Mode: ${cli.execute ? 'EXECUTE' : 'dry run'}`,
);

const repairs: Repair[] = [];
const reports: Report[] = [];
let scanned = 0;
const now = Date.now();

for await (const item of scanAll(dynamo, {
  TableName: billingTable,
  FilterExpression:
    'sk = :sk AND begins_with(pk, :org) AND attribute_exists(subscriptionId) AND attribute_not_exists(deletedAt) AND subscriptionStatus IN (:active, :pastDue, :grace, :canceled)',
  ExpressionAttributeValues: {
    ':sk': { S: SubscriptionKeys.sk() },
    ':org': { S: SubscriptionKeys.orgPkPrefix() },
    ':active': { S: 'active' },
    ':pastDue': { S: 'past_due' },
    ':grace': { S: 'grace_period' },
    ':canceled': { S: 'canceled' },
  },
})) {
  const raw = decodeRow<Row>(item);
  const pk = text(raw.pk);
  const subscriptionId = text(raw.subscriptionId);
  const subscriptionStatus = text(raw.subscriptionStatus);
  if (!pk || !subscriptionId || !subscriptionStatus) continue;
  const row: Row = {
    pk,
    orgId: pk.slice(SubscriptionKeys.orgPkPrefix().length),
    subscriptionId,
    subscriptionStatus,
    canceledAt: text(raw.canceledAt),
    gracePeriodEndsAt: text(raw.gracePeriodEndsAt),
  };
  scanned++;

  const live = row.subscriptionStatus === 'active' || row.subscriptionStatus === 'past_due';
  if (!live && !hasShortGrace(row)) continue;

  const subscription = await retrieve(row.subscriptionId);
  await sleep(STRIPE_DELAY_MS);
  if (!subscription || subscription.status !== 'canceled' || !subscription.ended_at) continue;

  const endedAt = new Date(subscription.ended_at * 1000);
  if (live) {
    // The row was live when Stripe ended it, which is what a paying org gets.
    repairs.push({
      row,
      canceledAt: endedAt.toISOString(),
      gracePeriodEndsAt: new Date(endedAt.getTime() + PAID_GRACE_DAYS * DAY_MS).toISOString(),
    });
  } else if (wasPaid(subscription)) {
    const paidDeadline = new Date(
      new Date(row.canceledAt!).getTime() + PAID_GRACE_DAYS * DAY_MS,
    ).toISOString();
    const note =
      row.subscriptionStatus === 'canceled'
        ? Date.parse(paidDeadline) > now
          ? 'disabled; its 30 days have not run out yet'
          : 'disabled 23 days early'
        : 'in grace, ends 23 days early';
    reports.push({ row, paidDeadline, note });
  }
}

console.log(`\nScanned ${scanned} subscription rows.`);

console.log(`\nRepair: ${repairs.length} rows Stripe canceled that are still live (FIL-1494)`);
for (const { row, canceledAt, gracePeriodEndsAt } of repairs) {
  console.log(
    `  ${row.orgId}  ${row.subscriptionId}  ${row.subscriptionStatus} -> grace_period  canceledAt=${canceledAt}  gracePeriodEndsAt=${gracePeriodEndsAt}`,
  );
}

console.log(`\nReport: ${reports.length} paid orgs given 7 days of grace (FIL-1460), not changed`);
for (const { row, paidDeadline, note } of reports) {
  console.log(
    `  ${row.orgId}  ${row.subscriptionId}  ${row.subscriptionStatus}  canceledAt=${row.canceledAt}  gracePeriodEndsAt=${row.gracePeriodEndsAt}  30-day deadline=${paidDeadline}  ${note}`,
  );
}

if (!cli.execute) {
  console.log('\nDry run: nothing written. Pass --execute to apply the repairs.');
  process.exit(0);
}

let applied = 0;
let skipped = 0;
for (const { row, canceledAt, gracePeriodEndsAt } of repairs) {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: billingTable,
        Key: { pk: { S: row.pk }, sk: { S: SubscriptionKeys.sk() } },
        UpdateExpression:
          'SET subscriptionStatus = :grace, canceledAt = :canceledAt, gracePeriodEndsAt = :ends, updatedAt = :now',
        ConditionExpression:
          'subscriptionStatus = :was AND subscriptionId = :sub AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':grace': { S: 'grace_period' },
          ':canceledAt': { S: canceledAt },
          ':ends': { S: gracePeriodEndsAt },
          ':now': { S: new Date().toISOString() },
          ':was': { S: row.subscriptionStatus },
          ':sub': { S: row.subscriptionId },
        },
      }),
    );
    applied++;
    console.log(`  repaired ${row.orgId}`);
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    skipped++;
    console.log(`  skipped ${row.orgId}: the row changed since the scan`);
  }
}
console.log(`\nApplied ${applied}, skipped ${skipped}.`);

/** A grace period that ran 7 days from the cancellation it followed. */
function hasShortGrace(row: Row): boolean {
  if (!row.canceledAt || !row.gracePeriodEndsAt) return false;
  const length = Date.parse(row.gracePeriodEndsAt) - Date.parse(row.canceledAt);
  return Math.abs(length - TRIAL_GRACE_DAYS * DAY_MS) <= SHORT_GRACE_TOLERANCE_MS;
}

function wasPaid(subscription: Stripe.Subscription): boolean {
  return Boolean(subscription.default_payment_method) || !subscription.trial_end;
}

async function retrieve(subscriptionId: string): Promise<Stripe.Subscription | undefined> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      console.warn(`  ${subscriptionId}: not found in Stripe, left alone`);
      return undefined;
    }
    throw error;
  }
}
