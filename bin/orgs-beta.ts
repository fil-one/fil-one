#!/usr/bin/env node

// Grant, revoke, and list access to the organizations beta — the flag that
// decides whether an org may create invitations, and whether the console shows
// it a members surface at all. Access is granted by the existence of a row in
// UserInfoTable with sort key ORGS_BETA; see
// packages/backend/src/lib/orgs-beta.ts and bin/README.md.
//
// Two kinds of target, and either one grants:
//
//   ORG#<orgId>            an entire organization
//   ALLOWLIST#<email>      one person, wherever they are a member
//
// Usage:
//   node bin/orgs-beta.ts list <stage>
//   node bin/orgs-beta.ts grant <stage> <orgId|email> [--execute]
//   node bin/orgs-beta.ts revoke <stage> <orgId|email> [--execute]
//   node bin/orgs-beta.ts check <stage> <orgId|email>
//
// A target containing `@` is an email; anything else must be an organization id.
//
// `grant` and `revoke` are dry runs unless `--execute` is passed: they print the
// row they would write or delete and stop. `list` and `check` only read.
//
// `check` exits 0 when the row exists, 2 when it does not.
//
// `<stage>` is the SST stage name: `production`, `staging`, or an ephemeral dev
// stage. There is no default.
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials, so make
// sure they target the right account before running.

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { scanAll } from './lib/dynamo.ts';
import { findTable, requireAwsProfile } from './lib/sst-state.ts';

/** The sort key both grant rows share, from packages/backend/src/lib/orgs-beta.ts. */
const ORGS_BETA_SK = 'ORGS_BETA';

const USAGE =
  'Usage: node bin/orgs-beta.ts <list|grant|revoke|check> <stage> [<orgId|email>] [--execute]';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const positional = args.filter((a) => a !== '--execute');
const [command, stage, target] = positional;

if (!command || !stage) {
  console.error(USAGE);
  process.exit(1);
}
if (command !== 'list' && command !== 'grant' && command !== 'revoke' && command !== 'check') {
  console.error(`Unknown command: ${command}\n${USAGE}`);
  process.exit(1);
}
if (command !== 'list' && !target) {
  console.error(`${command} needs a target.\n${USAGE}`);
  process.exit(1);
}

// Before any AWS work: a mistyped target should cost a message, not a state
// export against production.
const pk = target ? partitionKeyFor(target) : undefined;

requireAwsProfile();

console.error('Stage:', stage);
const { tableName, region } = findTable(stage, '::UserInfoTableTable');
console.error(`UserInfoTable: ${tableName} (region ${region})`);

const dynamo = new DynamoDBClient({ region });

switch (command) {
  case 'list':
    await listGrants();
    break;
  case 'grant':
    await grant(pk!);
    break;
  case 'revoke':
    await revoke(pk!);
    break;
  case 'check':
    await check(pk!);
    break;
}

/**
 * Which row a target names.
 *
 * The backend lowercases the email before its lookup, so the key has to use the
 * lowercased form or the grant is invisible to the check it was written for.
 */
function partitionKeyFor(value: string): string {
  if (value.includes('@')) return `ALLOWLIST#${value.toLowerCase()}`;

  // An org id is a UUID everywhere it is written. Refusing anything else keeps
  // a mistyped email — or a name somebody pasted — from writing a row that
  // grants nothing and reads as a grant in `list`.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    console.error(`Not an email address or an organization id: ${value}`);
    process.exit(1);
  }
  return `ORG#${value.toLowerCase()}`;
}

async function grant(pk: string): Promise<void> {
  if (await rowExists(pk)) {
    console.error(`Already granted: ${pk} / ${ORGS_BETA_SK} exists on stage "${stage}".`);
    return;
  }
  if (!execute) {
    console.error(`DRY RUN: would write ${pk} / ${ORGS_BETA_SK}. Pass --execute to apply.`);
    return;
  }

  // The row's existence is the grant — no other attributes are read.
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
    }),
  );

  // A consistent read-back, because granting the flag is something somebody
  // does and then immediately tries.
  if (!(await rowExists(pk))) {
    console.error('Verification failed: the row is not readable after the put.');
    process.exit(1);
  }

  console.error(
    `Granted the organizations beta to ${pk} on stage "${stage}". ` +
      'The console caches GET /me for 10 minutes — the customer may need to reload.',
  );
}

async function revoke(pk: string): Promise<void> {
  if (!execute) {
    const exists = await rowExists(pk);
    console.error(
      exists
        ? `DRY RUN: would delete ${pk} / ${ORGS_BETA_SK}. Pass --execute to apply.`
        : `DRY RUN: ${pk} / ${ORGS_BETA_SK} does not exist — nothing to delete.`,
    );
    return;
  }

  const { Attributes } = await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
      ReturnValues: 'ALL_OLD',
    }),
  );

  console.error(
    Attributes
      ? `Revoked the organizations beta from ${pk} on stage "${stage}".`
      : `${pk} did not hold the organizations beta on stage "${stage}" — nothing to delete.`,
  );

  // Revoking one row does not settle the question: the other kind of row grants
  // independently, and an operator who revoked an org still has to deal with
  // the people inside it.
  if (Attributes && pk.startsWith('ORG#')) {
    console.error(
      'Members of that org keep the beta if they hold an ALLOWLIST# row of their own — `list` shows them.',
    );
  }
}

async function check(pk: string): Promise<void> {
  if (await rowExists(pk)) {
    console.error(`${pk} HAS the organizations beta on stage "${stage}".`);
    process.exit(0);
  }
  console.error(`${pk} does NOT have the organizations beta on stage "${stage}".`);
  process.exit(2);
}

async function listGrants(): Promise<void> {
  // A scan, because the grants are spread across two partition-key shapes and
  // the table has no index on the sort key. The flag is a beta with a handful
  // of rows, so the whole table is read once and filtered server-side.
  const rows: string[] = [];
  for await (const item of scanAll(dynamo, {
    TableName: tableName,
    FilterExpression: 'sk = :sk',
    ExpressionAttributeValues: { ':sk': { S: ORGS_BETA_SK } },
    ProjectionExpression: 'pk',
  })) {
    const pk = item.pk?.S;
    if (pk) rows.push(pk);
  }

  if (rows.length === 0) {
    console.error(`Nobody holds the organizations beta on stage "${stage}".`);
    return;
  }

  rows.sort();
  console.error(`${rows.length} grant(s) on stage "${stage}":`);
  for (const pk of rows) console.log(pk);
}

async function rowExists(pk: string): Promise<boolean> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
      // Same consistency the backend gate uses, so this answers what the next
      // request will see rather than what a replica happens to hold.
      ConsistentRead: true,
    }),
  );
  return Item !== undefined;
}
