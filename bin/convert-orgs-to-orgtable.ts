#!/usr/bin/env node

// Usage: ./bin/convert-orgs-to-orgtable.ts [--execute]
//
// Moves organization membership out of UserInfoTable and into OrgTable, and
// converts the legacy `admin` role to `owner` on the way (IAM M1, FIL-1013).
// Every pre-M1 account is an org of one whose membership row nothing reads, so
// the move is a rewrite into the new table rather than an in-place migration.
//
// Per org, in one OrgTable transaction:
//   ORG#{orgId}   / MEMBER#{userId}      role=owner, joinedAt, source=conversion
//   USER#{userId} / MEMBERSHIP#{orgId}   the inverse item
//   ORG#{orgId}   / META                 ownerCount=1
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
//   ./bin/convert-orgs-to-orgtable.ts              # dry run
//   ./bin/convert-orgs-to-orgtable.ts --execute
//
// Target staging (AWS account 654654381893):
//   pnpm exec sst shell --stage staging -- node ./bin/convert-orgs-to-orgtable.ts
//   pnpm exec sst shell --stage staging -- node ./bin/convert-orgs-to-orgtable.ts --execute
//
// Target production (AWS account 811430801166):
//   pnpm exec sst shell --stage production -- node ./bin/convert-orgs-to-orgtable.ts
//   pnpm exec sst shell --stage production -- node ./bin/convert-orgs-to-orgtable.ts --execute
//
// The `--` between `--stage <name>` and `node` keeps `sst shell` from parsing
// `--execute` as one of its own flags. Confirm the stage printed at startup
// before running with --execute.
//
// There is no DynamoDB PITR/backup, so the per-org log is the only audit trail —
// capture stdout when running for real, e.g. `... --execute | tee convert.log`.
//
// Preconditions, verification queries, and the revert procedure:
// docs/OrgConversionRunbook.md. The revert is ./bin/revert-org-conversion.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const USAGE = 'Usage: ./bin/convert-orgs-to-orgtable.ts [--execute]  (dry run by default)';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  console.log('Runbook: docs/OrgConversionRunbook.md');
  process.exit(0);
}

const KNOWN_FLAGS = new Set(['--execute', '--dry-run']);
const unknownFlags = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  console.error(`Unrecognized argument(s): ${unknownFlags.join(' ')}`);
  console.error(USAGE);
  process.exit(1);
}

// --dry-run is accepted as a no-op so the flag from the other bin/ migrations
// never reads as "execute"; a run carrying both stays a dry run.
const execute = process.argv.includes('--execute') && !process.argv.includes('--dry-run');

// Re-exec under `sst shell` if SST resources aren't available
if (!process.env.SST_RESOURCE_App) {
  execFileSync(
    'pnpm',
    ['exec', 'sst', 'shell', '--', 'node', import.meta.filename, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(0);
}

import { Resource } from 'sst';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  buildConversionTransactItems,
  classifyOrg,
  CONVERTED_ROLE,
  formatPlanReport,
  legacyMemberKey,
  OrgKeys,
  parseMemberSk,
  parseOrgPk,
  parseUserPk,
  UserInfoKeys,
} from './lib/org-conversion.ts';
import type { ConvertPlan, OrgPlan, OrgState, ScanCounts } from './lib/org-conversion.ts';

/** Pause between orgs that write, so a few thousand transactions stay polite to a shared table. */
const WRITE_DELAY_MS = 50;

const userInfoTable = Resource.UserInfoTable.name;
const orgTable = Resource.OrgTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();

// `sst shell --stage X` leaves .sst/stage untouched, so the stage we were asked
// for and the resources we actually resolved can disagree. SST default-names
// the table `filone-<stage>-UserInfoTableTable`; assert the match rather than
// trusting the flag — the banner below is the operator's only confirmation of
// which data this run is about to rewrite. (Same guard as
// bin/reset-region-provisioning.ts.)
if (!userInfoTable.includes(`filone-${stage}-`) || !orgTable.includes(`filone-${stage}-`)) {
  console.error(
    `Stage mismatch: .sst/stage says "${stage}" but resolved tables "${userInfoTable}" and "${orgTable}".`,
  );
  process.exit(1);
}

// Mirrors the region logic in sst.config.ts app() — don't trust ambient
// AWS_REGION for staging/production, whose home region is fixed.
const awsRegion =
  stage === 'staging' || stage === 'production'
    ? 'us-east-2'
    : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');

const dynamo = new DynamoDBClient({ region: awsRegion });

console.log(
  `${execute ? 'EXECUTE — ' : 'DRY-RUN — '}Converting org membership into OrgTable (stage="${stage}", region=${awsRegion})`,
);
console.log(`  UserInfoTable: ${userInfoTable}`);
console.log(`  OrgTable:      ${orgTable}`);
console.log('');

const scan: ScanCounts = {
  userInfoRows: 0,
  orgProfiles: 0,
  legacyMemberRows: 0,
  userProfiles: 0,
  unparsedRows: 0,
  orgTableMemberRows: 0,
  orgTableMetaRows: 0,
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

/**
 * One pass over UserInfoTable collects everything the classification needs: org
 * profiles (the repair source), the legacy membership rows, and the set of user
 * ids that have a profile (a membership naming anyone else is an anomaly).
 */
async function scanUserInfoTable(): Promise<void> {
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: userInfoTable,
        FilterExpression:
          '(begins_with(pk, :orgPrefix) AND (sk = :profile OR begins_with(sk, :memberPrefix)))' +
          ' OR (begins_with(pk, :userPrefix) AND sk = :profile)',
        // No `email`: the oldest membership rows still carry one, but the
        // project stopped storing it deliberately (commit 4f02a70, "removing
        // stored email entirely to resolve issues when email is changed"), so
        // it is not carried into OrgTable and goes with the deleted row.
        ProjectionExpression: 'pk, sk, #role, joinedAt, createdBy, createdAt',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: {
          ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
          ':userPrefix': { S: OrgKeys.userPkPrefix() },
          ':profile': { S: UserInfoKeys.profileSk() },
          ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    lastKey = result.LastEvaluatedKey;

    for (const item of result.Items ?? []) {
      scan.userInfoRows++;
      collectUserInfoRow(item);
    }
  } while (lastKey);
}

function collectUserInfoRow(item: Record<string, AttributeValue>): void {
  const pk = item.pk?.S ?? '';
  const sk = item.sk?.S ?? '';

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
    orgState(orgId).profile = {
      ...(item.createdBy?.S ? { createdBy: item.createdBy.S } : {}),
      ...(item.createdAt?.S ? { createdAt: item.createdAt.S } : {}),
    };
    return;
  }

  const memberId = parseMemberSk(sk);
  if (!memberId) {
    scan.unparsedRows++;
    return;
  }
  scan.legacyMemberRows++;
  orgState(orgId).legacyMembers.push({
    userId: memberId,
    ...(item.role?.S ? { role: item.role.S } : {}),
    ...(item.joinedAt?.S ? { joinedAt: item.joinedAt.S } : {}),
  });
}

/**
 * OrgTable's existing rows: memberships from previous runs and from signups
 * since the write path deployed, plus the META rows. META is read because it
 * outlives a removed membership — an org with META and no member has been
 * handled already, and repairing it from `PROFILE.createdBy` would put back a
 * membership somebody deleted.
 */
async function scanOrgTable(): Promise<void> {
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: orgTable,
        FilterExpression:
          'begins_with(pk, :orgPrefix) AND (begins_with(sk, :memberPrefix) OR sk = :meta)',
        ProjectionExpression: 'pk, sk',
        ExpressionAttributeValues: {
          ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
          ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
          ':meta': { S: OrgKeys.orgMetaSk() },
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    lastKey = result.LastEvaluatedKey;

    for (const item of result.Items ?? []) {
      const orgId = parseOrgPk(item.pk?.S ?? '');
      if (!orgId) continue;
      const sk = item.sk?.S ?? '';

      if (sk === OrgKeys.orgMetaSk()) {
        scan.orgTableMetaRows++;
        orgState(orgId).hasMeta = true;
        continue;
      }

      const userId = parseMemberSk(sk);
      if (!userId) continue;
      scan.orgTableMemberRows++;
      orgState(orgId).orgTableMemberUserIds.push(userId);
    }
  } while (lastKey);
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
 * A cancelled transaction means one of the three conditions lost, which is
 * either a previous run or a signup that beat us to the org. Neither is an
 * error and neither may be overwritten, so the row is re-read consistently: if
 * the membership this plan would have written is there, the org is done and its
 * legacy row is cleaned up; if it is not, the org is left alone and reported.
 */
async function applyConversion(plan: ConvertPlan): Promise<ApplyOutcome> {
  const { orgId, userId } = plan;

  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: buildConversionTransactItems(plan, orgTable),
      }),
    );
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;

    if (!(await hasOrgTableMembership(orgId, userId))) {
      const reasons = (err.CancellationReasons ?? []).map((reason) => reason.Code).join(',');
      console.warn(
        `  CONFLICT ${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)} — transaction cancelled (${reasons}) and no membership row exists; left for manual review`,
      );
      return 'conflict';
    }

    if (plan.legacyRow) await deleteLegacyRow(orgId, userId);
    return 'raced';
  }

  if (plan.legacyRow) await deleteLegacyRow(orgId, userId);
  return 'converted';
}

function describe(plan: ConvertPlan): string {
  const joined = plan.joinedAt ? `joinedAt=${plan.joinedAt}` : 'joinedAt=(none recorded)';
  // The role as read, not as expected: this log is the only record of what the
  // row said before it was deleted.
  const origin =
    plan.origin === 'member-row'
      ? `${OrgKeys.memberSk(plan.userId)} ${plan.fromRole ?? '(no role)'}->${CONVERTED_ROLE}`
      : `repaired from PROFILE.createdBy -> ${CONVERTED_ROLE}`;
  return `${OrgKeys.orgPk(plan.orgId)} ${origin} ${joined} source=conversion`;
}

await scanUserInfoTable();
await scanOrgTable();

const plans: OrgPlan[] = [...orgs.values()]
  .map((state) => classifyOrg(state, knownUserIds))
  .sort((a, b) => a.orgId.localeCompare(b.orgId));

console.log(formatPlanReport(scan, plans));
console.log('');

const outcomes = {
  converted: 0,
  repaired: 0,
  alreadyConverted: 0,
  raced: 0,
  conflict: 0,
  legacyDeleted: 0,
  anomalies: 0,
};

for (const plan of plans) {
  if (plan.kind === 'anomaly') {
    outcomes.anomalies++;
    continue;
  }

  if (plan.kind === 'already-converted') {
    outcomes.alreadyConverted++;
    if (!plan.legacyRowPending) continue;
    console.log(
      `  ${execute ? '' : '[dry-run] '}${OrgKeys.orgPk(plan.orgId)} already in OrgTable — deleting the legacy ${OrgKeys.memberSk(plan.userId)} row`,
    );
    if (!execute) continue;

    // The scan is minutes old by the time this runs, and a legacy row may only
    // be deleted while the OrgTable row that replaced it exists, so the
    // replacement is re-read consistently rather than trusted from the scan.
    if (await hasOrgTableMembership(plan.orgId, plan.userId)) {
      await deleteLegacyRow(plan.orgId, plan.userId);
      outcomes.legacyDeleted++;
    } else {
      console.warn(
        `  CONFLICT ${OrgKeys.orgPk(plan.orgId)} ${OrgKeys.memberSk(plan.userId)} — the OrgTable membership is gone; legacy row kept`,
      );
      outcomes.conflict++;
    }
    await sleep(WRITE_DELAY_MS);
    continue;
  }

  console.log(`  ${execute ? '' : '[dry-run] '}${describe(plan)}`);
  if (!execute) continue;

  const outcome = await applyConversion(plan);
  if (outcome === 'converted') {
    if (plan.origin === 'member-row') outcomes.converted++;
    else outcomes.repaired++;
    if (plan.legacyRow) outcomes.legacyDeleted++;
  } else if (outcome === 'raced') {
    outcomes.raced++;
    if (plan.legacyRow) outcomes.legacyDeleted++;
  } else {
    outcomes.conflict++;
  }
  await sleep(WRITE_DELAY_MS);
}

console.log('');
if (execute) {
  console.log(`Converted (from legacy MEMBER# rows):  ${outcomes.converted}`);
  console.log(`Repaired (from PROFILE.createdBy):     ${outcomes.repaired}`);
  console.log(`Already converted before this run:     ${outcomes.alreadyConverted}`);
  console.log(`Raced (a concurrent write got there first): ${outcomes.raced}`);
  console.log(`Legacy MEMBER# rows deleted:           ${outcomes.legacyDeleted}`);
  console.log(`Conflicts (manual review):             ${outcomes.conflict}`);
  console.log(`Anomalies (untouched):                 ${outcomes.anomalies}`);
  console.log('');
  console.log("The plan's Convert + Repair equals Converted + Repaired + Raced + Conflicts.");
  console.log('Run the verification queries in docs/OrgConversionRunbook.md and record the');
  console.log('remaining legacy MEMBER# row count — the enforcement PR merges on that number.');
  if (outcomes.conflict > 0) process.exitCode = 1;
} else {
  console.log('Dry run only — nothing was written.');
  console.log('Disposition every anomaly above, then re-run with --execute.');
}
console.log('Done.');
