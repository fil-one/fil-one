#!/usr/bin/env node

// Start or re-drive an account deletion by hand.
//
// The teardown is driven by the DELETION record in UserInfoTable
// (pk = ORG#<orgId>, sk = DELETION) and executed by the AccountDeletionWorker
// Lambda — see packages/backend/src/jobs/account-deletion-worker.ts. Normally
// that record is committed by the self-serve confirm route or by the Stripe
// `customer.deleted` webhook, and AccountDeletionSweepCron re-drives anything
// left PENDING every 15 minutes. This script is the operator's version of both:
// `start` commits the record, `restart` re-invokes the worker now rather than
// waiting up to 15 minutes for the sweeper.
//
// Usage:
//   node bin/account-deletion.ts status  <orgId> --stage <stage>
//   node bin/account-deletion.ts restart <orgId> --stage <stage> [--dry-run] [--yes]
//   node bin/account-deletion.ts start   <orgId> --stage <stage> [--dry-run] [--yes]
//
//   node bin/account-deletion.ts status  3f8a1c2e-... --stage production
//   node bin/account-deletion.ts restart 3f8a1c2e-... --stage production --yes
//
// `--stage` is required and has no default: these commands are irreversible and
// production is a legitimate target, so the stage is never inferred from
// .sst/stage or $USER.
//
// `status` is read-only. It exits 0 when the deletion is complete or was never
// requested, and 2 while one is still PENDING.
//
// `restart` re-invokes the worker for a deletion that is already committed. It
// deliberately does not reset `attempts`: that counter is the failure history
// and the input to the BlockedAccountDeletion metric, and it stops mattering by
// itself once the record reaches DONE and drops out of the sweeper's scan.
//
// `start` commits a new DELETION record and raises the org fence in one
// transaction, then invokes the worker. Use it only when no record exists —
// a deletion already on file is a `restart`.
//
// PREREQUISITE for `restart`: the stage must have PR #632 deployed. Before it,
// every worker pass died in resolveDeletionTargets with a ValidationException
// (`sub` is a DynamoDB reserved word), so a re-drive only reproduces it.
//
// This destroys customer data and cannot be undone, and there is no DynamoDB
// PITR — the audit log on stdout is the only record. Capture it when running
// for real, e.g. `... --yes | tee deletion.log`.
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running. Resource names come from `sst state export`.

import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { execFileSync } from 'node:child_process';

const USAGE =
  'Usage: node bin/account-deletion.ts <status|restart|start> <orgId> --stage <stage> [--dry-run] [--yes]';

// Inlined from packages/backend/src/lib/deletion-record.ts — bin scripts must
// not import from the backend or @filone/shared. Keep in sync.
const DELETION_STATUS = { pending: 'PENDING', done: 'DONE' } as const;
const OPERATOR_TRIGGER = 'OPERATOR';

// Passes beyond which a teardown is not retrying but blocked — BLOCKED_ATTEMPTS
// in packages/backend/src/jobs/account-deletion-sweeper.ts. Keep in sync.
const BLOCKED_ATTEMPTS = 10;

const command = process.argv[2];
const orgId = process.argv[3];

if (!command || !orgId || orgId.startsWith('--')) usage('Missing <command> or <orgId>.');
if (command !== 'status' && command !== 'restart' && command !== 'start') {
  usage(`Unknown command: ${command}`);
}

const stage = readFlag('stage') ?? usage('--stage is required and has no default.');
const dryRun = process.argv.includes('--dry-run');
const confirmed = process.argv.includes('--yes');

// The AWS SDK resolves credentials from the profile; without it the DynamoDB
// calls fail late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  const profile = stage === 'production' ? 'filone-production' : 'filone-sandbox';
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      `  aws sso login --profile ${profile}\n` +
      `  export AWS_PROFILE=${profile}`,
  );
  process.exit(1);
}

console.error(`Stage: ${stage}`);
console.error(`Org ID: ${orgId}`);

const resources = findResources(stage);

// `sst state export --stage X` is the only thing that ties this run to a stage,
// so assert the resolved names match rather than trusting the flag.
if (!resources.userInfoTable.includes(`filone-${stage}-`)) {
  console.error(
    `Stage mismatch: --stage "${stage}" but resolved table "${resources.userInfoTable}".`,
  );
  process.exit(1);
}

console.error(`UserInfoTable: ${resources.userInfoTable} (region ${resources.region})`);
console.error(`Worker: ${resources.workerFunctionName}`);

const dynamo = new DynamoDBClient({ region: resources.region });
const lambda = new LambdaClient({ region: resources.region });

switch (command) {
  case 'status':
    await runStatus();
    break;
  case 'restart':
    await runRestart();
    break;
  case 'start':
    await runStart();
    break;
}

// ── Commands ────────────────────────────────────────────────────

/** Read-only. Exit 2 while a deletion is still PENDING, so callers can branch. */
async function runStatus(): Promise<void> {
  const { record, profile } = await readDeletionState();
  printDeletionBlock(record, profile);
  await printBillingResidue(record, profile);
  process.exit(record && record.status !== DELETION_STATUS.done ? 2 : 0);
}

async function runRestart(): Promise<void> {
  const { record, profile } = await readDeletionState();
  printDeletionBlock(record, profile);

  if (!record) {
    console.error(
      `No DELETION record for org ${orgId} — nothing to restart. ` + 'Use `start` to commit one.',
    );
    process.exit(1);
  }
  if (record.status === DELETION_STATUS.done) {
    console.error('The deletion is already DONE. Re-driving it would do nothing.');
    process.exit(1);
  }

  requireConfirmation(`re-invoke the teardown worker for org ${orgId}`);
  await invokeWorker();
}

async function runStart(): Promise<void> {
  const { record, profile } = await readDeletionState();
  printDeletionBlock(record, profile);

  if (record) {
    console.error('A DELETION record already exists — use `restart` to re-drive it.');
    process.exit(1);
  }
  if (!profile) {
    console.error(`No ORG#${orgId} / PROFILE record — is that an org id on stage "${stage}"?`);
    process.exit(1);
  }

  requireConfirmation(`commit a new deletion and fence org ${orgId}`);

  // The audit lines are written only once the transaction has landed, so a
  // captured log never claims a write that failed.
  const now = new Date().toISOString();
  const plan = [
    `PUT ORG#${orgId}/DELETION status=${DELETION_STATUS.pending} ` +
      `trigger=${OPERATOR_TRIGGER} requestedAt=${now} attempts=0`,
    `SET ORG#${orgId}/PROFILE deleting=true updatedAt=${now}`,
  ];

  if (dryRun) {
    for (const line of plan) console.log(`[dry-run] ${line}`);
  } else {
    await commitDeletion(now);
    for (const line of plan) console.log(line);
  }

  await invokeWorker();
}

/**
 * The record and the fence in one transaction, mirroring
 * commitStripeTriggeredDeletion in
 * packages/backend/src/lib/deletion-confirm-transaction.ts: a DELETION record
 * must never exist without the fence up. No requestedByUserId — an operator
 * deletion has no requester.
 */
async function commitDeletion(now: string): Promise<void> {
  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: resources.userInfoTable,
              Item: marshall({
                pk: `ORG#${orgId}`,
                sk: 'DELETION',
                status: DELETION_STATUS.pending,
                trigger: OPERATOR_TRIGGER,
                requestedAt: now,
                attempts: 0,
                updatedAt: now,
              }),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: resources.userInfoTable,
              Key: orgKey('PROFILE'),
              UpdateExpression: 'SET deleting = :true, updatedAt = :now',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
            },
          },
        ],
      }),
    );
  } catch (err) {
    // CancellationReasons is positional: 0 is the record, 1 is the fence.
    if (err instanceof TransactionCanceledException) {
      const [record, fence] = err.CancellationReasons ?? [];
      if (record?.Code === 'ConditionalCheckFailed') {
        console.error('A deletion was committed concurrently — use `restart` instead.');
        process.exit(1);
      }
      if (fence?.Code === 'ConditionalCheckFailed') {
        console.error(`No ORG#${orgId} / PROFILE record to fence; nothing was written.`);
        process.exit(1);
      }
    }
    throw err;
  }
  console.error(`Committed the DELETION record and raised the fence for org ${orgId}.`);
}

/**
 * Async invoke, matching invokeAccountDeletionWorker in
 * packages/backend/src/lib/account-deletion-invoke.ts. Delivery is at-most-once;
 * the sweeper re-drives off the record if this never lands.
 */
async function invokeWorker(): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] INVOKE ${resources.workerFunctionName} {"orgId":"${orgId}"}`);
    return;
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: resources.workerFunctionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ orgId })),
    }),
  );

  console.log(`Invoked ${resources.workerFunctionName} for org ${orgId}.`);
  console.error(
    'The worker runs asynchronously. Follow it with `bin/tail-logs.sh` ' +
      '(pick AccountDeletionWorker), then re-run `status` to confirm it reached DONE.',
  );
}

// ── Reads ───────────────────────────────────────────────────────

/** Consistent: a stale read right after a confirm misses the record entirely. */
async function readDeletionState(): Promise<{
  record?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}> {
  const [record, profile] = await Promise.all([readOrgRow('DELETION'), readOrgRow('PROFILE')]);
  return { record, profile };
}

async function readOrgRow(sk: string): Promise<Record<string, unknown> | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: resources.userInfoTable,
      Key: orgKey(sk),
      ConsistentRead: true,
    }),
  );
  return Item ? unmarshall(Item) : undefined;
}

function orgKey(sk: string): Record<string, AttributeValue> {
  return { pk: { S: `ORG#${orgId}` }, sk: { S: sk } };
}

/**
 * The org's SUBSCRIPTION rows. The Stripe webhook backfills `orgId` lazily, so
 * records written before that backfill are reachable only through the creator's
 * key — read that too (see findOrgSubscriptions in bin/aurora-preview-url.ts).
 */
async function findSubscriptions(creatorUserId: unknown): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let cursor: Record<string, AttributeValue> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await dynamo.send(
      new ScanCommand({
        TableName: resources.billingTable,
        FilterExpression: 'sk = :subscription AND orgId = :orgId',
        ExpressionAttributeValues: {
          ':subscription': { S: 'SUBSCRIPTION' },
          ':orgId': { S: orgId },
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    for (const item of Items ?? []) records.push(unmarshall(item));
    cursor = LastEvaluatedKey;
  } while (cursor);

  if (typeof creatorUserId === 'string') {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: resources.billingTable,
        Key: { pk: { S: `CUSTOMER#${creatorUserId}` }, sk: { S: 'SUBSCRIPTION' } },
      }),
    );
    const creatorRecord = Item ? unmarshall(Item) : null;
    if (creatorRecord && !records.some((r) => r.pk === creatorRecord.pk)) {
      records.push(creatorRecord);
    }
  }

  return records;
}

// ── Reporting ───────────────────────────────────────────────────

function printDeletionBlock(
  record: Record<string, unknown> | undefined,
  profile: Record<string, unknown> | undefined,
): void {
  console.error('');
  console.error('=== Account deletion ===');
  if (profile?.name) console.error(`Org name: ${formatValue(profile.name)}`);
  console.error(`State: ${describeDeletion(record, profile)}`);

  if (record) {
    printFields(record, [
      'status',
      'trigger',
      'requestedAt',
      'requestedByUserId',
      'attempts',
      'updatedAt',
    ]);
  }
  console.error(`Fence (PROFILE.deleting): ${profile?.deleting === true ? 'up' : 'not set'}`);
  console.error(
    `Scrub (PROFILE.deletedAt): ${profile?.deletedAt ? formatValue(profile.deletedAt) : 'not run'}`,
  );
}

/** The one line an operator reads before deciding what to do. */
function describeDeletion(
  record: Record<string, unknown> | undefined,
  profile: Record<string, unknown> | undefined,
): string {
  if (!record) {
    return profile?.deleting === true
      ? 'INCONSISTENT — the org is fenced (deleting=true) but has no DELETION record'
      : 'not requested';
  }
  if (record.status === DELETION_STATUS.done) return 'complete';

  const attempts = typeof record.attempts === 'number' ? record.attempts : 0;
  if (attempts > BLOCKED_ATTEMPTS) {
    return `BLOCKED — ${attempts} failed passes since ${formatValue(record.requestedAt)}`;
  }
  return `in progress — ${attempts} pass(es) since ${formatValue(record.requestedAt)}`;
}

/**
 * What the teardown should have cleaned up and has not. The scrub is what stamps
 * `deletedAt` and writes `subscriptionStatus = canceled` (scrubBilling in
 * packages/backend/src/lib/deletion-scrub.ts), and it is the last step — so an
 * unstamped row on a deletion that is not DONE means the status shown is stale.
 */
async function printBillingResidue(
  record: Record<string, unknown> | undefined,
  profile: Record<string, unknown> | undefined,
): Promise<void> {
  const subscriptions = await findSubscriptions(profile?.createdBy);

  console.error('');
  console.error('=== Subscription (BillingTable) ===');
  if (subscriptions.length === 0) {
    console.error('No subscription record — the account holds no entitlement.');
    return;
  }

  const teardownIncomplete = record !== undefined && record.status !== DELETION_STATUS.done;
  for (const subscription of subscriptions) {
    console.error(`Billing record: ${formatValue(subscription.pk)}`);
    printFields(subscription, [
      'subscriptionStatus',
      'subscriptionId',
      'stripeCustomerId',
      'trialEndsAt',
      'deletedAt',
      'updatedAt',
    ]);
    if (teardownIncomplete && !subscription.deletedAt) {
      console.error(
        `  ^ STALE: the deletion has not reached the scrub, so ` +
          `"${formatValue(subscription.subscriptionStatus)}" is the last webhook write, ` +
          'not the live Stripe state.',
      );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

interface StateResource {
  type: string;
  urn: string;
  outputs?: { name?: string; arn?: string };
}

/**
 * SST gives resources physical names the state export knows and `sst shell`
 * cannot resolve in production. One export, three lookups: the two tables carry
 * a random suffix, and the worker name is read rather than assumed so a rename
 * in sst.config.ts surfaces here instead of failing at invoke time.
 */
function findResources(stage: string): {
  userInfoTable: string;
  billingTable: string;
  workerFunctionName: string;
  region: string;
} {
  const json = execFileSync('pnpm', ['exec', 'sst', 'state', 'export', '--stage', stage], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const all: StateResource[] = JSON.parse(json).latest?.resources ?? [];

  const find = (type: string, urnSuffix: string): { name: string; arn?: string } => {
    const resource = all.find((r) => r.type === type && r.urn.endsWith(urnSuffix));
    const name = resource?.outputs?.name;
    if (!name) {
      console.error(`Could not find ${urnSuffix} in SST state for stage "${stage}".`);
      process.exit(1);
    }
    return { name, arn: resource?.outputs?.arn };
  };

  const userInfo = find('aws:dynamodb/table:Table', '::UserInfoTableTable');
  const billing = find('aws:dynamodb/table:Table', '::BillingTableTable');
  const worker = find('aws:lambda/function:Function', '::AccountDeletionWorkerFunction');

  return {
    userInfoTable: userInfo.name,
    billingTable: billing.name,
    workerFunctionName: worker.name,
    // us-east-2 for production/staging (see sst.config.ts); dev stages deploy
    // anywhere, so take the region from the ARN rather than guessing.
    region: userInfo.arn?.split(':')[3] ?? 'us-east-2',
  };
}

/** Every write is irreversible, so --yes is required and never implied. */
function requireConfirmation(action: string): void {
  if (dryRun || confirmed) return;
  console.error('');
  console.error(
    `About to ${action} on stage "${stage}". This cannot be undone.\n` +
      'Re-run with --yes to proceed, or --dry-run to see what would happen.',
  );
  process.exit(1);
}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) usage(`Missing value for --${name}.`);
  return value;
}

function printFields(record: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (record[field] !== undefined) console.error(`${field}: ${formatValue(record[field])}`);
  }
}

function formatValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}
