#!/usr/bin/env node

// Usage: ./bin/prefill-trial-entitlement-org.ts --stage <name> [--execute]
//
// Run before deploying PR 717 (multi-org part 4). A trial claim written before
// 717 (`EMAIL_NORM#…/TRIAL_ENTITLEMENT` in UserInfoTable) has a `userId` and no
// `orgId`, and 717 stamps the first org its owner asks from onto such a claim.
// This run stamps the org the trial actually went to first, so a person whose
// trial succeeded cannot collect a second one from a new solo org.
//
// Rule: the org whose BillingTable `ORG#…/SUBSCRIPTION` row names the claim's
// userId and carries a trial or subscription. With no such row, the one org
// that came with the account: an OrgTable membership whose source is neither
// `invitation` nor `manual`, the only kind the claim could be spent on. Several
// candidates, or none, leave the row alone and name it in the summary.
//
// DRY RUN BY DEFAULT; --execute writes. Each write is `SET orgId` conditioned on
// `attribute_not_exists(orgId) AND userId = :userId`, so re-running is safe and
// a claim a live request stamped first is left as it is.
//
//   ./bin/prefill-trial-entitlement-org.ts --stage staging
//   ./bin/prefill-trial-entitlement-org.ts --stage staging --execute 2>&1 | tee prefill-trial.log
//
// Like the other migrations, table names come from `sst state export --stage`
// and AWS calls use your ambient credentials.

import { parseCli } from './lib/args.ts';

const cli = parseCli({
  script: './bin/prefill-trial-entitlement-org.ts',
  runbook: 'bin/README.md',
});

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { OrgMembershipSource } from '@filone/shared';
import type { SubscriptionRecord } from '@filone/backend/src/lib/dynamo-records.ts';
import { OrgKeys } from '@filone/backend/src/lib/org-membership.ts';
import { SubscriptionKeys } from '@filone/backend/src/lib/subscription-store.ts';
import { TrialEntitlementKeys } from '@filone/backend/src/lib/trial-entitlement.ts';
import { parseOrgPk } from './lib/billing-rekey.ts';
import { decodeRow, scanAll, text } from './lib/dynamo.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';
import { billsTrialTo, isHomeMembership, resolveTrialOrg } from './lib/trial-entitlement-org.ts';

const tables = resolveStageTables(cli.stage, {
  UserInfoTable: '::UserInfoTableTable',
  BillingTable: '::BillingTableTable',
  OrgTable: '::OrgTableTable',
});
assertStageResources(cli.stage, tables);

const awsRegion = awsRegionForStage(cli.stage);
const dynamo = new DynamoDBClient({ region: awsRegion });

/** userId -> the orgs whose subscription row carries that user's trial or subscription. */
async function readBillingOrgs(): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  const rows = scanAll(dynamo, {
    TableName: tables.BillingTable,
    FilterExpression: 'sk = :sk AND begins_with(pk, :orgPrefix)',
    ExpressionAttributeValues: {
      ':sk': { S: SubscriptionKeys.sk() },
      ':orgPrefix': { S: SubscriptionKeys.orgPkPrefix() },
    },
    ConsistentRead: true,
  });
  for await (const item of rows) {
    const row = decodeRow<SubscriptionRecord>(item);
    const userId = text(row.userId);
    const orgId = parseOrgPk(text(row.pk) ?? '');
    if (!userId || !orgId || !billsTrialTo(row, userId)) continue;
    byUser.set(userId, [...(byUser.get(userId) ?? []), orgId]);
  }
  return byUser;
}

/** The orgs that came with the account, from the user's OrgTable memberships. */
async function readHomeOrgs(userId: string): Promise<string[]> {
  const { Items = [] } = await dynamo.send(
    new QueryCommand({
      TableName: tables.OrgTable,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.userPk(userId) },
        ':prefix': { S: OrgKeys.membershipSkPrefix() },
      },
      ConsistentRead: true,
    }),
  );
  const homeOrgIds: string[] = [];
  for (const item of Items) {
    const orgId = OrgKeys.parseMembershipSk(item.sk?.S ?? '');
    if (!orgId) continue;
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: tables.OrgTable,
        Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
        ProjectionExpression: '#source',
        ExpressionAttributeNames: { '#source': 'source' },
        ConsistentRead: true,
      }),
    );
    if (Item && isHomeMembership(Item.source?.S as OrgMembershipSource | undefined)) {
      homeOrgIds.push(orgId);
    }
  }
  return homeOrgIds;
}

/** False when the claim gained an org, or changed owner, since the scan read it. */
async function stamp(pk: string, userId: string, orgId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tables.UserInfoTable,
        Key: { pk: { S: pk }, sk: { S: TrialEntitlementKeys.sk() } },
        UpdateExpression: 'SET orgId = :orgId',
        ConditionExpression: 'attribute_not_exists(orgId) AND userId = :userId',
        ExpressionAttributeValues: { ':orgId': { S: orgId }, ':userId': { S: userId } },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

interface Tally {
  counts: { scanned: number; stamped: number; alreadySet: number; raced: number };
  unresolved: string[];
}

async function processClaim(
  item: Record<string, AttributeValue>,
  billingOrgs: Map<string, string[]>,
  { counts, unresolved }: Tally,
): Promise<void> {
  counts.scanned++;
  const claim = decodeRow<{ pk: string; userId: string; orgId: string }>(item);
  const pk = text(claim.pk) ?? '';
  if (text(claim.orgId)) {
    counts.alreadySet++;
    return;
  }
  const userId = text(claim.userId);
  if (!userId) {
    unresolved.push(`${pk} — no userId`);
    return;
  }

  const resolution = resolveTrialOrg({
    billingOrgIds: billingOrgs.get(userId) ?? [],
    homeOrgIds: billingOrgs.has(userId) ? [] : await readHomeOrgs(userId),
  });
  if ('reason' in resolution) {
    unresolved.push(`${pk} userId=${userId} — ${resolution.reason}`);
    return;
  }

  const label = `${pk} userId=${userId} -> orgId=${resolution.orgId} (${resolution.via})`;
  if (!cli.execute) {
    counts.stamped++;
    console.log(`  WOULD STAMP ${label}`);
  } else if (await stamp(pk, userId, resolution.orgId)) {
    counts.stamped++;
    console.log(`  STAMPED ${label}`);
  } else {
    counts.raced++;
    console.log(`  RACED ${label} — the claim changed since the scan; left as it is`);
  }
}

function printSummary({ counts, unresolved }: Tally): void {
  console.log('');
  for (const line of unresolved) console.log(`  UNRESOLVED ${line}`);
  console.log('');
  console.log(`Scanned:     ${counts.scanned}`);
  console.log(`${cli.execute ? 'Stamped:    ' : 'Would stamp:'} ${counts.stamped}`);
  console.log(`Already set: ${counts.alreadySet}`);
  if (cli.execute) console.log(`Raced:       ${counts.raced}`);
  console.log(`Unresolved:  ${unresolved.length}`);
  console.log('');
  if (!cli.execute) console.log('Dry run only — nothing was written.');
  console.log('Done.');
}

async function main(): Promise<void> {
  const mode = cli.execute ? 'EXECUTE — ' : 'DRY-RUN — ';
  console.log(
    `${mode}Stamping the org on pre-existing trial entitlement claims (stage="${cli.stage}", region=${awsRegion})`,
  );
  for (const [label, name] of Object.entries(tables)) console.log(`  ${label}: ${name}`);
  console.log('');

  const billingOrgs = await readBillingOrgs();
  const tally: Tally = {
    counts: { scanned: 0, stamped: 0, alreadySet: 0, raced: 0 },
    unresolved: [],
  };
  const claims = scanAll(dynamo, {
    TableName: tables.UserInfoTable,
    FilterExpression: 'sk = :sk AND begins_with(pk, :prefix)',
    ExpressionAttributeValues: {
      ':sk': { S: TrialEntitlementKeys.sk() },
      ':prefix': { S: TrialEntitlementKeys.pkPrefix() },
    },
    ProjectionExpression: 'pk, userId, orgId',
    ConsistentRead: true,
  });
  for await (const item of claims) await processClaim(item, billingOrgs, tally);

  printSummary(tally);
}

await main();
