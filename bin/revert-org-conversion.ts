#!/usr/bin/env node

// Usage: ./bin/revert-org-conversion.ts [--execute]
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
// way. Deleting them would delete counters the write path owns.
//
// One asymmetry: the conversion also CREATED memberships for the early cohort
// that never had a `UserInfoTable` row (repaired from `PROFILE.createdBy`), and
// the stored row does not record which orgs those were. Reverting them writes a
// legacy row those orgs never had — harmless, since nothing reads it, and a
// re-run of the conversion repairs them again the same way.
//
// DRY RUN BY DEFAULT. Pass --execute to apply.
//
//   ./bin/revert-org-conversion.ts              # dry run
//   ./bin/revert-org-conversion.ts --execute
//
// Target staging (AWS account 654654381893):
//   pnpm exec sst shell --stage staging -- node ./bin/revert-org-conversion.ts
//   pnpm exec sst shell --stage staging -- node ./bin/revert-org-conversion.ts --execute
//
// Target production (AWS account 811430801166):
//   pnpm exec sst shell --stage production -- node ./bin/revert-org-conversion.ts
//   pnpm exec sst shell --stage production -- node ./bin/revert-org-conversion.ts --execute
//
// The `--` between `--stage <name>` and `node` keeps `sst shell` from parsing
// `--execute` as one of its own flags. Confirm the stage printed at startup
// before running with --execute.
//
// There is no DynamoDB PITR/backup, so the per-row log is the only audit trail —
// capture stdout when running for real, e.g. `... --execute | tee revert.log`.
//
// When to reach for this, and what to check afterwards:
// docs/OrgConversionRunbook.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const USAGE = 'Usage: ./bin/revert-org-conversion.ts [--execute]  (dry run by default)';

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
  DynamoDBClient,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  buildRevertTransactItems,
  CONVERSION_SOURCE,
  LEGACY_ROLE,
  OrgKeys,
  parseMemberSk,
  parseOrgPk,
} from './lib/org-conversion.ts';
import type { ConvertedMembership } from './lib/org-conversion.ts';

/** Pause between transactions, matching the conversion's pacing. */
const WRITE_DELAY_MS = 50;

const userInfoTable = Resource.UserInfoTable.name;
const orgTable = Resource.OrgTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();

// `sst shell --stage X` leaves .sst/stage untouched, so assert the resolved
// tables belong to the stage the banner is about to name (the same guard as
// bin/reset-region-provisioning.ts and the conversion script).
if (!userInfoTable.includes(`filone-${stage}-`) || !orgTable.includes(`filone-${stage}-`)) {
  console.error(
    `Stage mismatch: .sst/stage says "${stage}" but resolved tables "${userInfoTable}" and "${orgTable}".`,
  );
  process.exit(1);
}

// Mirrors the region logic in sst.config.ts app().
const awsRegion =
  stage === 'staging' || stage === 'production'
    ? 'us-east-2'
    : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');

const dynamo = new DynamoDBClient({ region: awsRegion });

console.log(
  `${execute ? 'EXECUTE — ' : 'DRY-RUN — '}Reverting converted memberships to UserInfoTable (stage="${stage}", region=${awsRegion})`,
);
console.log(`  UserInfoTable: ${userInfoTable}`);
console.log(`  OrgTable:      ${orgTable}`);
console.log('');

/** Every OrgTable membership the conversion wrote, and nothing else. */
async function scanConvertedMemberships(): Promise<ConvertedMembership[]> {
  const memberships: ConvertedMembership[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: orgTable,
        FilterExpression:
          'begins_with(pk, :orgPrefix) AND begins_with(sk, :memberPrefix) AND #source = :conversion',
        ProjectionExpression: 'pk, sk, joinedAt',
        ExpressionAttributeNames: { '#source': 'source' },
        ExpressionAttributeValues: {
          ':orgPrefix': { S: OrgKeys.orgPkPrefix() },
          ':memberPrefix': { S: OrgKeys.memberSkPrefix() },
          ':conversion': { S: CONVERSION_SOURCE },
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    lastKey = result.LastEvaluatedKey;

    for (const item of result.Items ?? []) {
      const orgId = parseOrgPk(item.pk?.S ?? '');
      const userId = parseMemberSk(item.sk?.S ?? '');
      if (!orgId || !userId) continue;
      memberships.push({
        orgId,
        userId,
        ...(item.joinedAt?.S ? { joinedAt: item.joinedAt.S } : {}),
      });
    }
  } while (lastKey);

  return memberships;
}

const memberships = await scanConvertedMemberships();
memberships.sort((a, b) => a.orgId.localeCompare(b.orgId));

console.log(`Converted memberships found (source="${CONVERSION_SOURCE}"): ${memberships.length}`);
console.log(
  `Each restores ${OrgKeys.memberSk('{userId}')} in UserInfoTable with role="${LEGACY_ROLE}" and removes the OrgTable membership and its inverse item.`,
);
console.log('');

let reverted = 0;
let skipped = 0;

for (const membership of memberships) {
  const { orgId, userId, joinedAt } = membership;
  console.log(
    `  ${execute ? '' : '[dry-run] '}${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)} owner->${LEGACY_ROLE} joinedAt=${joinedAt ?? '(none recorded)'}`,
  );
  if (!execute) continue;

  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: buildRevertTransactItems(membership, { userInfoTable, orgTable }),
      }),
    );
    reverted++;
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;

    // Only a failed condition means "the row stopped being a conversion's, so
    // whatever rewrote it owns it now." A cancellation for any other reason —
    // throttling, a transaction conflict, a validation error — is a failure to
    // do the work, and reporting it as a deliberate skip would leave rows
    // converted behind a clean summary. TransactWriteItems is not retried per
    // item by the SDK, so those stop the run.
    const codes = (err.CancellationReasons ?? []).map((reason) => reason.Code ?? '');
    if (!codes.includes('ConditionalCheckFailed')) {
      console.error(
        `  FAILED ${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)} — transaction cancelled (${codes.join(',')})`,
      );
      throw err;
    }

    console.warn(
      `  SKIPPED ${OrgKeys.orgPk(orgId)} ${OrgKeys.memberSk(userId)} — no longer an untouched ${CONVERSION_SOURCE} row`,
    );
    skipped++;
  }
  await sleep(WRITE_DELAY_MS);
}

console.log('');
if (execute) {
  console.log(`Reverted: ${reverted}`);
  console.log(`Skipped (rewritten since the scan): ${skipped}`);
  console.log('META rows left in place, as designed.');
} else {
  console.log('Dry run only — nothing was written.');
  console.log(`Would revert ${memberships.length} memberships.`);
}
console.log('Done.');
