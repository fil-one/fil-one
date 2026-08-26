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
//   node bin/orgs-beta.ts revoke <stage> <orgId|email> [--execute] [--force-members]
//   node bin/orgs-beta.ts check <stage> <orgId|email>
//
// A target containing `@` is an email; anything else must be an organization id.
// An `ORG#` target has to name an organization that exists: `grant` and `check`
// read its profile row first, so an id pasted from the wrong field of `GET /me`
// is refused instead of being written as a grant no request ever reads.
//
// `grant` and `revoke` are dry runs unless `--execute` is passed: they print the
// row they would write or delete and stop. `--dry-run` beats `--execute`, the
// way bin/lib/args.ts resolves the pair, and any other `--` argument is refused
// rather than ignored. `list` and `check` only read.
//
// Revoking an organization takes the console's members surface away from an
// Owner who belongs to no other org, so a revoke against an org with more than
// one member stops and asks for `--force-members`. Either kind of revoke then
// prints the invitations that stay acceptable, because accepting one is not
// gated on this flag.
//
// `check` exits 0 when the row exists, 2 when it does not, and 1 when the
// organization named does not exist.
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
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { scanAll } from './lib/dynamo.ts';
import { findTable, requireAwsProfile } from './lib/sst-state.ts';

/** The sort key both grant rows share, from packages/backend/src/lib/orgs-beta.ts. */
const ORGS_BETA_SK = 'ORGS_BETA';

/** The allowlist partition key, from packages/backend/src/lib/orgs-beta.ts. */
const ALLOWLIST_PK_PREFIX = 'ALLOWLIST#';

/** Key shapes owned by OrgKeys in packages/backend/src/lib/org-membership.ts. */
const ORG_PK_PREFIX = 'ORG#';
const MEMBER_SK_PREFIX = 'MEMBER#';
const INVITE_SK_PREFIX = 'INVITE#';

/** The org profile row, in UserInfoTable — every org has one (lib/account-creation.ts). */
const ORG_PROFILE_SK = 'PROFILE';

const USAGE =
  'Usage: node bin/orgs-beta.ts <list|grant|revoke|check> <stage> [<orgId|email>] [--execute] [--force-members]';

/**
 * Every flag this script understands.
 *
 * Enumerated so an unrecognized `--` argument stops the run, the way
 * bin/lib/args.ts stops on one. Filtering positionals by shape alone lets a
 * misspelled flag fall into the positional list, where the three-way
 * destructure below drops it and the run proceeds as if it were never passed —
 * which for a flag whose whole job is to prevent a write is the worst place to
 * be silent.
 */
const KNOWN_FLAGS = new Set(['--execute', '--dry-run', '--force-members']);

const args = process.argv.slice(2);
const unknownFlag = args.find((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg));
if (unknownFlag) {
  console.error(`Unrecognized argument: ${unknownFlag}\n${USAGE}`);
  process.exit(1);
}

// A run carrying both flags stays a dry run, as it does in the migration
// scripts: the flag that refuses to write wins.
const execute = args.includes('--execute') && !args.includes('--dry-run');
const forceMembers = args.includes('--force-members');
const positional = args.filter((arg) => !arg.startsWith('--'));
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

/**
 * The table holding membership and invitation rows, resolved only when a revoke
 * needs it.
 *
 * The grant rows live in UserInfoTable, but what a revoke takes away — a
 * roster, a pending invitation — lives in OrgTable, so the two questions the
 * revoke path asks need a second lookup. It is lazy because reading it costs an
 * `sst state export`, and `list`, `grant` and `check` never ask. Same stage, so
 * the same region and the same client.
 */
let orgTableName: string | undefined;
function requireOrgTable(): string {
  orgTableName ??= findTable(stage!, '::OrgTableTable').tableName;
  return orgTableName;
}

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
  if (value.includes('@')) return `${ALLOWLIST_PK_PREFIX}${value.toLowerCase()}`;

  // An org id is a UUID everywhere it is written. Refusing anything else keeps
  // a mistyped email — or a name somebody pasted — from writing a row that
  // grants nothing and reads as a grant in `list`.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    console.error(`Not an email address or an organization id: ${value}`);
    process.exit(1);
  }
  return `${ORG_PK_PREFIX}${value.toLowerCase()}`;
}

async function grant(pk: string): Promise<void> {
  await requireOrgExists(pk);

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
  if (!(await rowExists(pk))) {
    console.error(
      execute
        ? `${pk} did not hold the organizations beta on stage "${stage}" — nothing to delete.`
        : `DRY RUN: ${pk} / ${ORGS_BETA_SK} does not exist — nothing to delete.`,
    );
    return;
  }

  // What the revoke would take away and what it would leave, read before it
  // happens so a dry run reports what the real one will find.
  const orgId = orgIdFrom(pk);
  const memberCount = orgId === undefined ? 0 : await countMembers(orgId);
  const stranded = await acceptableInvitations(pk);

  // An org's second member is why this is a stop rather than a warning. The
  // console offers the members surface to a caller in more than one org, or one
  // whose org holds this flag (use-members-surface.ts), so an Owner who belongs
  // only to the org being revoked loses the roster, the role picker, removal
  // and transfer over members who remain members. The API keeps serving all
  // four, which is what makes the loss easy to miss.
  if (memberCount > 1) {
    console.error(
      `WARNING: organization ${orgId} has ${memberCount} members. Revoking the beta leaves them ` +
        'in the org and takes the console members surface away from any Owner or Admin who ' +
        'belongs to no other org. The API still permits every members call.',
    );
    if (!forceMembers) {
      console.error('Refusing to revoke. Pass --force-members if that is what you mean.');
      process.exit(1);
    }
  }

  if (!execute) {
    console.error(`DRY RUN: would delete ${pk} / ${ORGS_BETA_SK}. Pass --execute to apply.`);
    reportSurvivingGrants(pk, stranded);
    return;
  }

  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
    }),
  );

  console.error(`Revoked the organizations beta from ${pk} on stage "${stage}".`);
  reportSurvivingGrants(pk, stranded);
}

/**
 * What the revoke did not take away.
 *
 * Two things outlive it, and an operator who reads the delete as the end of the
 * question gets both wrong. The other kind of row grants independently, in
 * whichever direction this target was not. And accepting an invitation reads no
 * flag at all (handlers/accept-invitation.ts), so every invitation already sent
 * is still good — a revoke removes the console path to withdrawing one, not the
 * invitation.
 */
function reportSurvivingGrants(pk: string, stranded: readonly AcceptableInvitation[]): void {
  const allowlistTarget = !pk.startsWith(ORG_PK_PREFIX);

  console.error(
    allowlistTarget
      ? 'Their organization may still hold an ORG# row, which grants the beta on its own — `list` shows it.'
      : 'Members of that org keep the beta if they hold an ALLOWLIST# row of their own — `list` shows them.',
  );

  if (allowlistTarget) {
    // The rows below are matched by recipient (`emailNorm`); the sender is
    // stored as a userId, so invitations this person already SENT cannot be
    // found by email and are not listed. They stay acceptable exactly like the
    // ones below — a revoked grant stops future creation, nothing else.
    console.error(
      'Invitations this person already sent are not listed (senders are stored by userId, ' +
        'not email) and stay acceptable; withdraw those per org if they matter.',
    );
  }

  if (stranded.length === 0) return;

  console.error(
    `${stranded.length} invitation(s) ${allowlistTarget ? 'addressed to this email' : 'sent by this org'} ` +
      'stay acceptable — accepting reads no flag, and each is good ' +
      'until it expires or somebody holding members.manage withdraws it:',
  );
  for (const invitation of stranded) {
    console.error(
      `  ${invitation.orgId} ${invitation.inviteId} ${invitation.email} ` +
        `(${invitation.role}, expires ${invitation.expiresAt})`,
    );
  }
}

async function check(pk: string): Promise<void> {
  await requireOrgExists(pk);

  const held = await rowExists(pk);
  console.error(
    held
      ? `${pk} HAS the organizations beta on stage "${stage}".`
      : `${pk} does NOT have the organizations beta on stage "${stage}".`,
  );

  // One row is not the answer to "is this person in the beta": the gate ORs
  // both shapes, so a row-scoped exit code read as a person-level verdict is
  // wrong in whichever direction was not asked about.
  console.error(
    pk.startsWith(ORG_PK_PREFIX)
      ? 'Members of that org may hold ALLOWLIST# rows of their own, which grant it — `list` shows them.'
      : 'Their organization may hold an ORG# row, which grants it — `list` shows it.',
  );

  process.exit(held ? 0 : 2);
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

/** The org id an `ORG#` target names; undefined for the allowlist shape. */
function orgIdFrom(pk: string): string | undefined {
  return pk.startsWith(ORG_PK_PREFIX) ? pk.slice(ORG_PK_PREFIX.length) : undefined;
}

/**
 * Stop when an `ORG#` target names no organization.
 *
 * The shape check upstream refuses a name or an email, not a UUID from the
 * wrong field: `GET /me` carries `userId` and `orgId` side by side and both are
 * `crypto.randomUUID()`, so the likeliest mistake reads back as a grant in
 * `check` and `list` while the gate — which looks the flag up under the
 * session's real org id — never sees the row. Reading the profile row is the
 * check bin/extend-trial.ts already makes; every org has one, so it refuses
 * nothing legitimate. Allowlist targets are exempt because an allowlist grant
 * is normally written before its person has ever logged in.
 */
async function requireOrgExists(pk: string): Promise<void> {
  const orgId = orgIdFrom(pk);
  if (orgId === undefined) return;

  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: ORG_PROFILE_SK } },
      ProjectionExpression: 'pk',
      ConsistentRead: true,
    }),
  );
  if (Item) return;

  console.error(
    `No organization ${orgId} on stage "${stage}": it has no ${pk} / ${ORG_PROFILE_SK} row. ` +
      'Check the id — `GET /me` reports `orgId` beside `userId`, and they are both UUIDs.',
  );
  process.exit(1);
}

/** How many members an org holds, counted server-side and paged to the end. */
async function countMembers(orgId: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Count, LastEvaluatedKey } = await dynamo.send(
      new QueryCommand({
        TableName: requireOrgTable(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `${ORG_PK_PREFIX}${orgId}` },
          ':skPrefix': { S: MEMBER_SK_PREFIX },
        },
        Select: 'COUNT',
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    count += Count ?? 0;
    startKey = LastEvaluatedKey;
  } while (startKey);

  return count;
}

/** One invitation a revoke leaves redeemable. */
interface AcceptableInvitation {
  orgId: string;
  inviteId: string;
  email: string;
  role: string;
  expiresAt: string;
}

/**
 * The invitations still redeemable after this target loses the flag.
 *
 * For an org, its own pending rows. For an address, the pending rows anywhere
 * that name it — a scan, because invitations are keyed by org and there is no
 * index on the invited address, and the same trade `list` already makes: this
 * is a beta with a handful of orgs and the script is run by hand.
 *
 * `pending` and unexpired is what `isInvitationUsable` means, and the expiry is
 * a read-time compare, so a row past its date is dropped here rather than
 * reported as something an operator has to act on.
 */
async function acceptableInvitations(pk: string): Promise<AcceptableInvitation[]> {
  const orgId = orgIdFrom(pk);
  const found: AcceptableInvitation[] = [];
  const now = Date.now();

  const rows =
    orgId === undefined
      ? scanAll(dynamo, {
          TableName: requireOrgTable(),
          FilterExpression:
            'begins_with(sk, :skPrefix) AND #status = :pending AND emailNorm = :emailNorm',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':skPrefix': { S: INVITE_SK_PREFIX },
            ':pending': { S: 'pending' },
            ':emailNorm': { S: pk.slice(ALLOWLIST_PK_PREFIX.length) },
          },
        })
      : queryInvitations(orgId);

  for await (const item of rows) {
    const sk = item.sk?.S;
    const rowPk = item.pk?.S;
    const expiresAt = item.expiresAt?.S;
    if (!sk || !rowPk || !expiresAt) continue;

    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed) || parsed <= now) continue;

    found.push({
      orgId: rowPk.slice(ORG_PK_PREFIX.length),
      inviteId: sk.slice(INVITE_SK_PREFIX.length),
      email: item.email?.S ?? '(no address)',
      role: item.role?.S ?? '(no role)',
      expiresAt,
    });
  }

  return found;
}

/** One org's pending invitation rows, paged to the end. */
async function* queryInvitations(orgId: string): AsyncGenerator<Record<string, AttributeValue>> {
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await dynamo.send(
      new QueryCommand({
        TableName: requireOrgTable(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':pk': { S: `${ORG_PK_PREFIX}${orgId}` },
          ':skPrefix': { S: INVITE_SK_PREFIX },
          ':pending': { S: 'pending' },
        },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    yield* Items ?? [];
    startKey = LastEvaluatedKey;
  } while (startKey);
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
