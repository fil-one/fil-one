#!/usr/bin/env node

// Usage: ./bin/convert-orgs-to-orgtable.ts --stage <name> [--execute] [--verify]
//        [--accept-anomalies <orgId,orgId,…>] [--force-unlock]
//
// Moves organization membership out of UserInfoTable and into OrgTable, and
// converts the legacy `admin` role to `owner` on the way (IAM M1, FIL-1013).
// Every pre-M1 account is an org of one whose membership row nothing reads, so
// the move is a rewrite into the new table rather than an in-place migration.
//
// Per org, in one OrgTable transaction:
//   ORG#{orgId}   / MEMBER#{userId}      role=owner, joinedAt, source=conversion
//   USER#{userId} / MEMBERSHIP#{orgId}   the inverse item
//   ORG#{orgId}   / META                 ownerCount=1, for an org that has none
// then the legacy UserInfoTable `ORG#{orgId}/MEMBER#{userId}` row is deleted —
// only after that transaction has succeeded.
//
// The early cohort has no membership row at all (the membership write landed a
// few days after the first accounts, and the #306 signup rework dropped a
// confirmation step). Those orgs are repaired from `ORG#{orgId}/PROFILE.createdBy`.
//
// DRY RUN BY DEFAULT. The run prints its full plan — counts, the repair cohort,
// the already-converted count, and every anomaly — before it writes anything,
// in both modes. Pass --execute to apply it.
//
// --stage is required and has no default: the target account is a decision, not
// something to inherit from whatever the shell was last used for. The run reads
// the physical table names out of `sst state export --stage <name>` (`sst
// shell` cannot evaluate providers against production), then asserts they carry
// `filone-<stage>-` before reading anything. AWS calls use your ambient
// credentials.
//
//   ./bin/convert-orgs-to-orgtable.ts --stage staging
//   ./bin/convert-orgs-to-orgtable.ts --stage staging --execute
//   ./bin/convert-orgs-to-orgtable.ts --stage production --verify
//
// Staging is AWS account 654654381893, production 811430801166. Confirm the
// stage and the table names printed at startup before running with --execute.
//
// --verify re-derives the classification and prints PASS/FAIL per check — the
// gate the enforcement PR merges on. It writes nothing.
//
// An anomaly fails --verify. Its org has no OrgTable membership and enforcement
// reads no other table, so merging enforcement while one stands locks that
// account out. Once an org has been looked at, name it to record the decision:
//
//   ./bin/convert-orgs-to-orgtable.ts --stage production --verify \
//     --accept-anomalies ORG#8f3c…,ORG#1a2b…
//
// The report echoes every acceptance, so the PASS an operator pastes onto the
// enforcement PR says which orgs were signed off and why each was an anomaly.
//
// An --execute run holds a lock row in OrgTable so the conversion and the
// revert can never run at once. --force-unlock drops a lock a crashed run left
// behind.
//
// There is no DynamoDB PITR/backup, so the per-org log is the only audit trail —
// capture the whole run when running for real:
//   ... --execute 2>&1 | tee convert.log
//
// Preconditions, verification, and the revert procedure:
// docs/OrgConversionRunbook.md. The revert is ./bin/revert-org-conversion.ts.

import { setTimeout as sleep } from 'node:timers/promises';

import { parseCli } from './lib/args.ts';

const cli = parseCli({
  script: './bin/convert-orgs-to-orgtable.ts',
  flags: ['--verify', '--force-unlock'],
  options: ['--accept-anomalies'],
  help: [
    '--verify        Re-check both tables and print PASS/FAIL. Writes nothing.',
    '--accept-anomalies <orgId,orgId,…>',
    '                With --verify: the anomaly orgs an operator has dispositioned.',
    '                Anomalies not named here fail verification.',
    '--force-unlock  Drop the run lock a crashed --execute run left behind.',
  ],
});

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteItemCommand, DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { decodeRow, scanAll, text, transactWithRetry } from './lib/dynamo.ts';
import { acquireRunLock, forceUnlock } from './lib/run-lock.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';
import {
  buildConversionTransactItems,
  classifyOrg,
  CONVERTED_ROLE,
  formatPlanReport,
  legacyMemberKey,
  OrgKeys,
  parseMemberSk,
  parseMembershipSk,
  parseOrgPk,
  parseUserPk,
  UNKNOWN_JOINED_AT,
  UserInfoKeys,
} from './lib/org-conversion.ts';
import type { ConvertPlan, OrgPlan, OrgState, ScanResult } from './lib/org-conversion.ts';
import { formatVerifyReport, parseAcceptedAnomalies, verifyConversion } from './lib/org-verify.ts';

/** Pause between orgs that write, so a few thousand transactions stay polite to a shared table. */
const WRITE_DELAY_MS = 50;

const { UserInfoTable: userInfoTable, OrgTable: orgTable } = resolveStageTables(cli.stage, {
  UserInfoTable: '::UserInfoTableTable',
  OrgTable: '::OrgTableTable',
});

assertStageResources(cli.stage, { UserInfoTable: userInfoTable, OrgTable: orgTable });

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });

const verify = cli.flag('--verify');
const execute = cli.execute && !verify;
const acceptedAnomalies = parseAcceptedAnomalies(cli.option('--accept-anomalies'));

// A disposition is a statement about what --verify may pass, and nothing else
// reads it. Accepting it on a run that cannot act on it would let an operator
// believe anomalies had been signed off when no check ever saw the list.
if (acceptedAnomalies.size > 0 && !verify) {
  console.error('--accept-anomalies applies to --verify only. Nothing was read or written.');
  process.exit(1);
}

if (cli.flag('--force-unlock')) {
  await forceUnlock(dynamo, orgTable);
  process.exit(0);
}

const mode = verify ? 'VERIFY — ' : execute ? 'EXECUTE — ' : 'DRY-RUN — ';
console.log(
  `${mode}Converting org membership into OrgTable (stage="${cli.stage}", region=${awsRegion})`,
);
console.log(`  UserInfoTable: ${userInfoTable}`);
console.log(`  OrgTable:      ${orgTable}`);
console.log('');

const scan: ScanResult = {
  userInfoRows: 0,
  orgProfiles: 0,
  legacyMemberRows: 0,
  userProfiles: 0,
  unparsedRows: 0,
  orgTableMemberRows: 0,
  orgTableInverseRows: 0,
  orgTableMetaRows: 0,
  // Both halves of every OrgTable membership, kept as pairs rather than counted,
  // so `--verify` can say which membership is missing which item.
  membership: { members: [], inverse: [] },
};

const orgs = new Map<string, OrgState>();
const knownUserIds = new Set<string>();

function orgState(orgId: string): OrgState {
  const existing = orgs.get(orgId);
  if (existing) return existing;
  const created: OrgState = {
    orgId,
    legacyMembers: [],
    orgTableMemberUserIds: [],
    hasMeta: false,
  };
  orgs.set(orgId, created);
  return created;
}

/** The UserInfoTable attributes the conversion projects, as one decoded row. */
interface UserInfoRow {
  pk: string;
  sk: string;
  role: string;
  joinedAt: string;
  createdBy: string;
  createdAt: string;
}

/** The OrgTable attributes the conversion projects. */
interface OrgTableRow {
  pk: string;
  sk: string;
  role: string;
}

/**
 * One pass over UserInfoTable collects everything the classification needs: org
 * profiles (the repair source), the legacy membership rows, and the set of user
 * ids that have a profile (a membership naming anyone else is an anomaly).
 */
async function scanUserInfoTable(): Promise<void> {
  const items = scanAll(dynamo, {
    TableName: userInfoTable,
    FilterExpression:
      '(begins_with(pk, :orgPrefix) AND (sk = :profile OR begins_with(sk, :memberPrefix)))' +
      ' OR (begins_with(pk, :userPrefix) AND sk = :profile)',
    // No `email`: the oldest membership rows still carry one, but the project
    // stopped storing it deliberately (commit 4f02a70, "removing stored email
    // entirely to resolve issues when email is changed"), so it is not carried
    // into OrgTable and goes with the deleted row.
    ProjectionExpression: 'pk, sk, #role, joinedAt, createdBy, createdAt',
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: {
      ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
      ':userPrefix': { S: OrgKeys.userPkPrefix() },
      ':profile': { S: UserInfoKeys.profileSk() },
      ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
    },
  });

  for await (const item of items) {
    scan.userInfoRows++;
    collectUserInfoRow(item);
  }
}

function collectUserInfoRow(item: Record<string, AttributeValue>): void {
  const row = decodeRow<UserInfoRow>(item);
  const pk = text(row.pk) ?? '';
  const sk = text(row.sk) ?? '';

  const userId = parseUserPk(pk);
  if (userId && sk === UserInfoKeys.profileSk()) {
    scan.userProfiles++;
    knownUserIds.add(userId);
    return;
  }

  const orgId = parseOrgPk(pk);
  if (!orgId) {
    scan.unparsedRows++;
    return;
  }

  if (sk === UserInfoKeys.profileSk()) {
    scan.orgProfiles++;
    const createdBy = text(row.createdBy);
    const createdAt = text(row.createdAt);
    orgState(orgId).profile = {
      ...(createdBy ? { createdBy } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
    return;
  }

  const memberId = parseMemberSk(sk);
  if (!memberId) {
    scan.unparsedRows++;
    return;
  }
  const role = text(row.role);
  const joinedAt = text(row.joinedAt);
  scan.legacyMemberRows++;
  orgState(orgId).legacyMembers.push({
    userId: memberId,
    ...(role ? { role } : {}),
    ...(joinedAt ? { joinedAt } : {}),
  });
}

/**
 * OrgTable's existing rows: memberships from previous runs and from signups
 * since the write path deployed, their inverse items, and the META rows. META
 * is read because it outlives a removed membership — an org with META, no
 * member and no legacy row has been handled already, and repairing it from
 * `PROFILE.createdBy` would put back a membership somebody deleted. The inverse
 * items are read, key and role, so `--verify` can hold each one against the
 * canonical row it belongs to rather than against a total.
 */
async function scanOrgTable(): Promise<void> {
  const items = scanAll(dynamo, {
    TableName: orgTable,
    FilterExpression:
      '(begins_with(pk, :orgPrefix) AND (begins_with(sk, :memberPrefix) OR sk = :meta))' +
      ' OR (begins_with(pk, :userPrefix) AND begins_with(sk, :membershipPrefix))',
    ProjectionExpression: 'pk, sk, #role',
    // `role` is a DynamoDB reserved word, so it can only be projected by alias.
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: {
      ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
      ':userPrefix': { S: OrgKeys.userPkPrefix() },
      ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
      ':membershipPrefix': { S: OrgKeys.membershipSkPrefix() },
      ':meta': { S: OrgKeys.orgMetaSk() },
    },
  });

  for await (const item of items) {
    const row = decodeRow<OrgTableRow>(item);
    const pk = text(row.pk) ?? '';
    const sk = text(row.sk) ?? '';
    const role = text(row.role);

    const inverseUserId = parseUserPk(pk);
    if (inverseUserId) {
      scan.orgTableInverseRows++;
      // A sort key that does not parse is still an item that ought to pair with
      // a membership and cannot, so the org id it names is carried through as
      // stored — it can match no canonical row, and the report says which item.
      const inverseOrgId = parseMembershipSk(sk) ?? sk.slice(OrgKeys.membershipSkPrefix().length);
      scan.membership.inverse.push({
        orgId: inverseOrgId,
        userId: inverseUserId,
        ...(role ? { role } : {}),
      });
      continue;
    }

    const orgId = parseOrgPk(pk);
    if (!orgId) continue;

    if (sk === OrgKeys.orgMetaSk()) {
      scan.orgTableMetaRows++;
      orgState(orgId).hasMeta = true;
      continue;
    }

    const userId = parseMemberSk(sk);
    if (!userId) continue;
    scan.orgTableMemberRows++;
    orgState(orgId).orgTableMemberUserIds.push(userId);
    scan.membership.members.push({ orgId, userId, ...(role ? { role } : {}) });
  }
}

async function deleteLegacyRow(orgId: string, userId: string): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({ TableName: userInfoTable, Key: legacyMemberKey(orgId, userId) }),
  );
}

async function hasOrgTableMembership(orgId: string, userId: string): Promise<boolean> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: orgTable,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
      ConsistentRead: true,
    }),
  );
  return Item !== undefined;
}

type ApplyOutcome = 'converted' | 'raced' | 'conflict';

/**
 * Apply one org's conversion.
 *
 * A cancelled transaction is read for what it says. A failed condition is
 * either a previous run or a signup that beat us to the org: neither is an
 * error and neither may be overwritten, so the row is re-read consistently — if
 * the membership this plan would have written is there, the org is done and its
 * legacy row is cleaned up; if it is not, the org is left alone and reported.
 * Throttling and transaction conflicts are retried; anything else stops the run
 * rather than being filed as an org that needs a human.
 */
async function applyConversion(plan: ConvertPlan): Promise<ApplyOutcome> {
  const { orgId, userId } = plan;
  const row = `${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)}`;

  const conditionFailed = await transactWithRetry(
    dynamo,
    buildConversionTransactItems(plan, orgTable),
    row,
  );

  if (conditionFailed && !(await hasOrgTableMembership(orgId, userId))) {
    console.log(
      `  CONFLICT ${row} — transaction cancelled (${conditionFailed.join(',')}) and no membership row exists; left for manual review`,
    );
    return 'conflict';
  }

  if (plan.legacyRow) await deleteLegacyRow(orgId, userId);
  return conditionFailed ? 'raced' : 'converted';
}

/**
 * One org's conversion, as the audit log records it.
 *
 * The role is named as read, not as expected, and the repair cohort names the
 * user it grants: the conversion invents that membership from
 * `PROFILE.createdBy`, and this line is the only record of who received it.
 */
function describe(plan: ConvertPlan): string {
  const joined =
    plan.joinedAt === UNKNOWN_JOINED_AT
      ? `joinedAt=${UNKNOWN_JOINED_AT} (none recorded)`
      : `joinedAt=${plan.joinedAt}`;
  const origin =
    plan.origin === 'member-row'
      ? `${OrgKeys.memberSk(plan.userId)} ${plan.fromRole ?? '(no role)'}->${CONVERTED_ROLE}`
      : `${OrgKeys.memberSk(plan.userId)} granted ${CONVERTED_ROLE} from PROFILE.createdBy`;
  const meta = plan.metaExists ? ' META=exists' : ' META=new';
  return `${OrgKeys.orgPk(plan.orgId)} ${origin} ${joined} source=conversion${meta}`;
}

await scanUserInfoTable();
await scanOrgTable();

const states = [...orgs.values()];
const plans: OrgPlan[] = states
  .map((state) => classifyOrg(state, knownUserIds))
  .sort((a, b) => a.orgId.localeCompare(b.orgId));

if (verify) {
  const checks = verifyConversion(states, plans, scan, acceptedAnomalies);
  console.log(formatVerifyReport(checks));
  process.exit(checks.some((check) => !check.pass) ? 1 : 0);
}

console.log(formatPlanReport(scan, plans));
console.log('');

const outcomes = {
  converted: 0,
  repaired: 0,
  alreadyConverted: 0,
  raced: 0,
  legacyDeleted: 0,
  staleLegacyDeleted: 0,
  transactionConflict: 0,
  legacyDeleteConflict: 0,
  anomalies: 0,
};

// Held for the whole write phase: the revert moves the same rows the other way,
// and one landing between this run's OrgTable transaction and its legacy-row
// delete would leave an org with neither membership.
const lock = execute
  ? await acquireRunLock(dynamo, orgTable, {
      script: 'convert-orgs-to-orgtable.ts',
      stage: cli.stage,
    })
  : undefined;

try {
  for (const plan of plans) {
    if (plan.kind === 'anomaly') {
      outcomes.anomalies++;
      continue;
    }

    if (plan.kind === 'already-converted') {
      outcomes.alreadyConverted++;
      if (!plan.legacyRowPending) continue;

      const row = `${OrgKeys.orgPk(plan.orgId)} ${OrgKeys.memberSk(plan.userId)}`;
      if (!execute) {
        console.log(`  [dry-run] SKIPPED ${row} already in OrgTable — deleting its legacy row`);
        continue;
      }

      // The scan is minutes old by the time this runs, and a legacy row may
      // only be deleted while the OrgTable row that replaced it exists, so the
      // replacement is re-read consistently rather than trusted from the scan.
      if (await hasOrgTableMembership(plan.orgId, plan.userId)) {
        await deleteLegacyRow(plan.orgId, plan.userId);
        outcomes.legacyDeleted++;
        outcomes.staleLegacyDeleted++;
        console.log(`  SKIPPED ${row} already in OrgTable — legacy row deleted`);
      } else {
        outcomes.legacyDeleteConflict++;
        console.log(`  CONFLICT ${row} — the OrgTable membership is gone; legacy row kept`);
      }
      await sleep(WRITE_DELAY_MS);
      continue;
    }

    if (!execute) {
      console.log(
        `  [dry-run] ${plan.origin === 'member-row' ? 'CONVERT' : 'REPAIR'} ${describe(plan)}`,
      );
      continue;
    }

    const outcome = await applyConversion(plan);
    if (outcome === 'converted') {
      if (plan.origin === 'member-row') outcomes.converted++;
      else outcomes.repaired++;
      if (plan.legacyRow) outcomes.legacyDeleted++;
      console.log(`  ${plan.origin === 'member-row' ? 'CONVERTED' : 'REPAIRED'} ${describe(plan)}`);
    } else if (outcome === 'raced') {
      outcomes.raced++;
      if (plan.legacyRow) outcomes.legacyDeleted++;
      console.log(
        `  RACED ${OrgKeys.orgPk(plan.orgId)} ${OrgKeys.memberSk(plan.userId)} — a concurrent write created the membership first${plan.legacyRow ? '; legacy row deleted' : ''}`,
      );
    } else {
      outcomes.transactionConflict++;
    }
    await sleep(WRITE_DELAY_MS);
  }
} finally {
  await lock?.release();
}

const planned = summarize();

console.log('');
if (execute) {
  console.log(`Converted (from legacy MEMBER# rows):        ${outcomes.converted}`);
  console.log(`Repaired (from PROFILE.createdBy):           ${outcomes.repaired}`);
  console.log(`Already converted before this run:           ${outcomes.alreadyConverted}`);
  console.log(`Raced (a concurrent write got there first):  ${outcomes.raced}`);
  console.log(`Legacy MEMBER# rows deleted:                 ${outcomes.legacyDeleted}`);
  console.log(`Conflicts — transaction (manual review):     ${outcomes.transactionConflict}`);
  console.log(`Conflicts — stale legacy row kept:           ${outcomes.legacyDeleteConflict}`);
  console.log(`Anomalies (untouched):                       ${outcomes.anomalies}`);
  console.log('');
  console.log(
    `Convert + Repair (${planned.writes}) = Converted + Repaired + Raced + transaction conflicts (${
      outcomes.converted + outcomes.repaired + outcomes.raced + outcomes.transactionConflict
    }).`,
  );
  console.log(
    `Stale legacy rows in the plan (${planned.staleLegacyRows}) = deleted (${outcomes.staleLegacyDeleted}) + stale-row conflicts (${outcomes.legacyDeleteConflict}).`,
  );
  console.log('');
  console.log('Now run --verify against the same stage and record its result — the enforcement');
  console.log('PR merges on a PASS, and any anomaly left standing has to be named on');
  console.log('--accept-anomalies to get one. See docs/OrgConversionRunbook.md.');
  if (outcomes.transactionConflict > 0 || outcomes.legacyDeleteConflict > 0) process.exitCode = 1;
} else {
  console.log('Dry run only — nothing was written.');
  console.log('Disposition every anomaly above, then re-run with --execute.');
}
console.log('Done.');

function summarize(): { writes: number; staleLegacyRows: number } {
  let writes = 0;
  let staleLegacyRows = 0;
  for (const plan of plans) {
    if (plan.kind === 'convert') writes++;
    else if (plan.kind === 'already-converted' && plan.legacyRowPending) staleLegacyRows++;
  }
  return { writes, staleLegacyRows };
}
