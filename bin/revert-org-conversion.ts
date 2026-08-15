#!/usr/bin/env node

// Usage: ./bin/revert-org-conversion.ts --stage <name> [--execute] [--force-unlock]
//
// Reverts ./bin/convert-orgs-to-orgtable.ts: puts membership back in
// UserInfoTable as `ORG#{orgId}/MEMBER#{userId}` with the legacy `admin` role,
// and removes the OrgTable rows the conversion created.
//
// Scope is defined by the data, not by a record of the run: only OrgTable
// membership rows carrying `source: 'conversion'` are reverted, so memberships
// written by signup (`source: 'signup'`) or later by an invitation are never
// touched. Each membership is reverted in one cross-table transaction — the
// legacy row returns and the canonical row plus its inverse item go away
// together, or nothing happens for that org.
//
// `ORG#{orgId}/META` rows are deliberately LEFT IN PLACE. They carry no
// provenance attribute, so a conversion-written META is indistinguishable from
// one written at signup, and `ownerCount: 1` is true for an org of one either
// way. The conversion knows this and writes no META for an org that has one, so
// a reverted org converts again cleanly.
//
// One asymmetry: the conversion also CREATED memberships for the early cohort
// that never had a `UserInfoTable` row (repaired from `PROFILE.createdBy`), and
// the stored row does not record which orgs those were. Reverting them writes a
// legacy row those orgs never had — harmless, since nothing reads it, and a
// re-run of the conversion repairs them again the same way.
//
// DRY RUN BY DEFAULT. Pass --execute to apply.
//
// --stage is required and has no default. The run re-execs itself under
// `sst shell --stage <name>`, then asserts the resolved table names carry
// `filone-<stage>-` before reading anything.
//
//   ./bin/revert-org-conversion.ts --stage staging
//   ./bin/revert-org-conversion.ts --stage staging --execute
//
// Staging is AWS account 654654381893, production 811430801166. Confirm the
// stage and the table names printed at startup before running with --execute.
//
// An --execute run holds the same OrgTable lock row the conversion takes, so
// the two can never run at once. --force-unlock drops a lock a crashed run left
// behind.
//
// There is no DynamoDB PITR/backup, so the per-row log is the only audit trail —
// capture the whole run when running for real:
//   ... --execute 2>&1 | tee revert.log
//
// When to reach for this, and what to check afterwards:
// docs/OrgConversionRunbook.md.

import { setTimeout as sleep } from 'node:timers/promises';

import { parseCli } from './lib/args.ts';
import { ensureSstShell } from './lib/stage.ts';

const cli = parseCli({
  script: './bin/revert-org-conversion.ts',
  flags: ['--force-unlock'],
  help: ['--force-unlock  Drop the run lock a crashed --execute run left behind.'],
});

ensureSstShell(cli.stage, import.meta.filename, cli.argv);

import { Resource } from 'sst';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { decodeRow, scanAll, text, transactWithRetry } from './lib/dynamo.ts';
import { acquireRunLock, forceUnlock } from './lib/run-lock.ts';
import { assertStageResources, awsRegionForStage } from './lib/stage.ts';
import {
  buildRevertTransactItems,
  CONVERSION_SOURCE,
  CONVERTED_ROLE,
  LEGACY_ROLE,
  OrgKeys,
  parseMemberSk,
  parseOrgPk,
  willRevert,
} from './lib/org-conversion.ts';
import type { ConvertedMembership } from './lib/org-conversion.ts';

/** Pause between transactions, matching the conversion's pacing. */
const WRITE_DELAY_MS = 50;

const userInfoTable = Resource.UserInfoTable.name;
const orgTable = Resource.OrgTable.name;

assertStageResources(cli.stage, { UserInfoTable: userInfoTable, OrgTable: orgTable });

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });

if (cli.flag('--force-unlock')) {
  await forceUnlock(dynamo, orgTable);
  process.exit(0);
}

const execute = cli.execute;

console.log(
  `${execute ? 'EXECUTE — ' : 'DRY-RUN — '}Reverting converted memberships to UserInfoTable (stage="${cli.stage}", region=${awsRegion})`,
);
console.log(`  UserInfoTable: ${userInfoTable}`);
console.log(`  OrgTable:      ${orgTable}`);
console.log('');

/** The OrgTable attributes the revert projects, as one decoded row. */
interface MembershipRow {
  pk: string;
  sk: string;
  joinedAt: string;
  role: string;
}

/**
 * Every OrgTable membership the conversion wrote, and nothing else.
 *
 * `role` is projected alongside the key: it is the other half of the delete's
 * condition, so reading it here is what lets the dry run report the rows the
 * transaction would decline instead of discovering them at execute time.
 */
async function scanConvertedMemberships(): Promise<ConvertedMembership[]> {
  const memberships: ConvertedMembership[] = [];

  const items = scanAll(dynamo, {
    TableName: orgTable,
    FilterExpression:
      'begins_with(pk, :orgPrefix) AND begins_with(sk, :memberPrefix) AND #source = :conversion',
    ProjectionExpression: 'pk, sk, joinedAt, #role',
    ExpressionAttributeNames: { '#source': 'source', '#role': 'role' },
    ExpressionAttributeValues: {
      ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
      ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
      ':conversion': { S: CONVERSION_SOURCE },
    },
  });

  for await (const item of items) {
    const row = decodeRow<MembershipRow>(item);
    const orgId = parseOrgPk(text(row.pk) ?? '');
    const userId = parseMemberSk(text(row.sk) ?? '');
    if (!orgId || !userId) continue;

    const joinedAt = text(row.joinedAt);
    const role = text(row.role);
    memberships.push({
      orgId,
      userId,
      ...(joinedAt ? { joinedAt } : {}),
      ...(role ? { role } : {}),
    });
  }

  return memberships;
}

const memberships = await scanConvertedMemberships();
memberships.sort((a, b) => a.orgId.localeCompare(b.orgId));

const planned = memberships.filter(willRevert);
const predictedSkips = memberships.length - planned.length;

const toRevert = `  To revert (role="${CONVERTED_ROLE}"):`;
const toSkip = '  To skip (role changed since the conversion):';
const labelWidth = Math.max(toRevert.length, toSkip.length) + 2;

console.log(`Converted memberships found (source="${CONVERSION_SOURCE}"): ${memberships.length}`);
console.log(`${toRevert.padEnd(labelWidth)}${planned.length}`);
console.log(`${toSkip.padEnd(labelWidth)}${predictedSkips}`);
console.log(
  `Each revert restores ${OrgKeys.memberSk('{userId}')} in UserInfoTable with role="${LEGACY_ROLE}" and removes the OrgTable membership and its inverse item.`,
);
console.log('META rows are left in place, as designed.');
console.log('');

let reverted = 0;
let skipped = 0;

// Held for the whole write phase: the conversion moves the same rows the other
// way, and one landing between this run's transaction and the next would leave
// an org with neither membership.
const lock = execute
  ? await acquireRunLock(dynamo, orgTable, { script: 'revert-org-conversion.ts', stage: cli.stage })
  : undefined;

try {
  for (const membership of memberships) {
    const { orgId, userId, joinedAt, role } = membership;
    const row = `${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)}`;
    const stored = `role=${role ?? '(none)'} joinedAt=${joinedAt ?? '(none recorded)'}`;

    if (!willRevert(membership)) {
      skipped++;
      console.log(
        `  ${execute ? '' : '[dry-run] '}SKIPPED ${row} ${stored} — no longer an untouched ${CONVERSION_SOURCE} row`,
      );
      continue;
    }

    if (!execute) {
      console.log(`  [dry-run] REVERT ${row} ${stored} ${CONVERTED_ROLE}->${LEGACY_ROLE}`);
      continue;
    }

    const outcome = await applyRevert(membership);
    if (outcome === 'reverted') {
      reverted++;
      console.log(`  REVERTED ${row} ${stored} ${CONVERTED_ROLE}->${LEGACY_ROLE}`);
    } else {
      skipped++;
      console.log(`  SKIPPED ${row} ${stored} — rewritten between the scan and the transaction`);
    }
    await sleep(WRITE_DELAY_MS);
  }
} finally {
  await lock?.release();
}

console.log('');
if (execute) {
  console.log(`Reverted: ${reverted}`);
  console.log(`Skipped (role changed since the conversion): ${skipped}`);
  console.log(`Planned ${planned.length} reverts and ${predictedSkips} skips.`);
  console.log('META rows left in place, as designed.');
} else {
  console.log('Dry run only — nothing was written.');
  console.log(`Would revert ${planned.length} memberships and skip ${predictedSkips}.`);
}
console.log('Done.');

/**
 * Revert one membership.
 *
 * Only a failed condition means "the row stopped being a conversion's, so
 * whatever rewrote it owns it now" — and only for a row that changed between
 * the scan and this transaction, since the same test already ran against the
 * scanned value. Throttling and transaction conflicts are retried; anything
 * else is a failure to do the work, and reporting it as a deliberate skip would
 * leave rows converted behind a clean summary.
 */
async function applyRevert(membership: ConvertedMembership): Promise<'reverted' | 'skipped'> {
  const row = `${OrgKeys.orgPk(membership.orgId)} ${OrgKeys.memberSk(membership.userId)}`;

  const conditionFailed = await transactWithRetry(
    dynamo,
    buildRevertTransactItems(membership, { userInfoTable, orgTable }),
    row,
  );

  return conditionFailed ? 'skipped' : 'reverted';
}
