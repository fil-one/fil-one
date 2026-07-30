#!/usr/bin/env node

// Usage: node bin/seed-e2e-billing-from-staging.ts
//
// Mirrors the identity + billing rows for the three E2E test users from a
// source stage (default `staging`) into the current stage so the existing
// `E2E_*_USER_ID` env vars (= staging-minted UUIDs used as BillingTable PK)
// work against a dev stage without re-running Auth0 first-login UUID minting.
//
// For each user, copies from the source stage:
//   UserInfoTable:
//     SUB#<sub> → IDENTITY               (so resolveUserAndOrg reuses the staging UUIDs)
//     USER#<userId> → PROFILE
//     ORG#<orgId> → PROFILE              (tenant-bound fields stripped — see below)
//     ORG#<orgId> → MEMBER#<userId>
//   BillingTable:
//     CUSTOMER#<userId> → SUBSCRIPTION
//
// The ORG# PROFILE row is intentionally not copied verbatim: `auroraTenantId`,
// `fthTenantId`, `auroraSetupFailureCount`, and the legacy `setupStatus` field
// are removed, and `auroraSetupStatus` is reset to `FILONE_ORG_CREATED` so the
// dev stage runs its own Aurora/FTH tenant setup against its own backends on
// first resource creation.
//
// Required env vars:
//   E2E_PAID_USER_ID, E2E_UNPAID_USER_ID, E2E_TRIAL_USER_ID
//
// Optional:
//   SOURCE_STAGE  (default: "staging")

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.SST_RESOURCE_App) {
  execFileSync('pnpm', ['exec', 'sst', 'shell', 'node', import.meta.filename], {
    stdio: 'inherit',
  });
  process.exit(0);
}

import { Resource } from 'sst';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

interface StageTables {
  billingTable: string;
  userInfoTable: string;
  region: string;
}

const PROTECTED_STAGES = ['staging', 'production'];
const SOURCE_STAGE = process.env.SOURCE_STAGE ?? 'staging';

// ORG# PROFILE fields that are stage-bound: tenant identifiers from the
// source stage's Aurora/FTH backends. Stripping them forces the target stage
// to run its own tenant setup against its own backends.
const STAGE_BOUND_ORG_FIELDS = [
  'auroraTenantId',
  'fthTenantId',
  'auroraSetupFailureCount',
  'setupStatus',
  'updatedAt',
] as const;

const FRESH_ORG_SETUP_STATUS = 'FILONE_ORG_CREATED';

const targetStage = readFileSync('.sst/stage', 'utf8').trim();
if (PROTECTED_STAGES.includes(targetStage)) {
  console.error(`Refusing to write into the "${targetStage}" stage.`);
  process.exit(1);
}
if (targetStage === SOURCE_STAGE) {
  console.error(`Source and target stage are both "${targetStage}".`);
  process.exit(1);
}

const roleUserIds: Array<{ role: string; userId: string }> = [
  { role: 'paid', userId: requireEnv('E2E_PAID_USER_ID') },
  { role: 'unpaid', userId: requireEnv('E2E_UNPAID_USER_ID') },
  { role: 'trial', userId: requireEnv('E2E_TRIAL_USER_ID') },
];

const target: StageTables = {
  billingTable: Resource.BillingTable.name,
  userInfoTable: Resource.UserInfoTable.name,
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-2',
};
const source = lookupStageTables(SOURCE_STAGE);

console.log(`Source "${SOURCE_STAGE}" (${source.region}):`);
console.log(`  UserInfoTable=${source.userInfoTable}`);
console.log(`  BillingTable=${source.billingTable}`);
console.log(`Target "${targetStage}" (${target.region}):`);
console.log(`  UserInfoTable=${target.userInfoTable}`);
console.log(`  BillingTable=${target.billingTable}`);

const sourceDdb = new DynamoDBClient({ region: source.region });
const targetDdb = new DynamoDBClient({ region: target.region });

for (const { role, userId } of roleUserIds) {
  console.log(`\n[${role}] userId=${userId}`);

  const userProfile = await getItem(sourceDdb, source.userInfoTable, {
    pk: { S: `USER#${userId}` },
    sk: { S: 'PROFILE' },
  });
  if (!userProfile) {
    console.error(`  no USER#${userId} row in ${SOURCE_STAGE} — skipping`);
    continue;
  }

  const sub = userProfile.sub?.S;
  const orgId = userProfile.orgId?.S;
  if (!sub || !orgId) {
    console.error(`  USER#${userId} missing sub/orgId — skipping`);
    continue;
  }
  console.log(`  sub=${sub}  orgId=${orgId}`);

  const identity = await getItem(sourceDdb, source.userInfoTable, {
    pk: { S: `SUB#${sub}` },
    sk: { S: 'IDENTITY' },
  });
  const orgProfile = await getItem(sourceDdb, source.userInfoTable, {
    pk: { S: `ORG#${orgId}` },
    sk: { S: 'PROFILE' },
  });
  const member = await getItem(sourceDdb, source.userInfoTable, {
    pk: { S: `ORG#${orgId}` },
    sk: { S: `MEMBER#${userId}` },
  });
  const billing = await getItem(sourceDdb, source.billingTable, {
    pk: { S: `CUSTOMER#${userId}` },
    sk: { S: 'SUBSCRIPTION' },
  });

  if (!identity || !orgProfile || !member || !billing) {
    console.error(`  missing source rows for ${role}:`, {
      identity: !!identity,
      orgProfile: !!orgProfile,
      member: !!member,
      billing: !!billing,
    });
    continue;
  }

  const freshOrgProfile = stripStageBoundFields(orgProfile);

  await putItem(targetDdb, target.userInfoTable, identity);
  await putItem(targetDdb, target.userInfoTable, userProfile);
  await putItem(targetDdb, target.userInfoTable, freshOrgProfile);
  await putItem(targetDdb, target.userInfoTable, member);
  await putItem(targetDdb, target.billingTable, billing);

  console.log(`  copied 4 UserInfoTable rows + 1 BillingTable row`);
}

console.log('\nDone.');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function getItem(
  client: DynamoDBClient,
  tableName: string,
  key: Record<string, AttributeValue>,
): Promise<Record<string, AttributeValue> | null> {
  const { Item } = await client.send(new GetItemCommand({ TableName: tableName, Key: key }));
  return Item ?? null;
}

async function putItem(
  client: DynamoDBClient,
  tableName: string,
  item: Record<string, AttributeValue>,
): Promise<void> {
  await client.send(new PutItemCommand({ TableName: tableName, Item: item }));
}

function stripStageBoundFields(
  orgProfile: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  const next = { ...orgProfile };
  for (const field of STAGE_BOUND_ORG_FIELDS) {
    delete next[field];
  }
  next.auroraSetupStatus = { S: FRESH_ORG_SETUP_STATUS };
  return next;
}

function lookupStageTables(stage: string): StageTables {
  // The probe runs inside `sst shell --stage <stage>`, which only accepts a
  // command + positional args (its flag parser rejects `node -e <expr>` because
  // `-e` looks like an unknown sst flag). Write a tiny CJS probe to a temp file
  // and have sst run that.
  const dir = mkdtempSync(join(tmpdir(), 'sst-seed-probe-'));
  const probePath = join(dir, 'probe.cjs');
  writeFileSync(
    probePath,
    'console.log("__SEED__" + JSON.stringify({' +
      'billingTable: JSON.parse(process.env.SST_RESOURCE_BillingTable).name,' +
      'userInfoTable: JSON.parse(process.env.SST_RESOURCE_UserInfoTable).name,' +
      'region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,' +
      '}));\n',
  );
  try {
    const raw = execFileSync(
      'pnpm',
      ['exec', 'sst', 'shell', '--stage', stage, 'node', probePath],
      { encoding: 'utf8' },
    );
    const line = raw.split('\n').find((l) => l.startsWith('__SEED__'));
    if (!line) {
      throw new Error(`Could not parse sst shell output for stage "${stage}":\n${raw}`);
    }
    return JSON.parse(line.slice('__SEED__'.length)) as StageTables;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
