#!/usr/bin/env node

// Manage RAG access for a customer email. Access is granted by the existence
// of an allowlist row (pk = ALLOWLIST#<lowercased-email>, sk = RAG) in
// UserInfoTable — see packages/backend/src/middleware/rag-access.ts and
// docs/enable-rag.md. No redeploy is required. Note: @fil.org (Foundation)
// emails always have access, regardless of the allowlist.
//
// Usage:
//   node bin/rag-access.ts enable <stage> <email>
//   node bin/rag-access.ts disable <stage> <email>
//   node bin/rag-access.ts check <stage> <email>
//
// `<stage>` is the SST stage name: `production`, `staging`, or the name of an
// ephemeral dev stage (the `--stage` value it was deployed with, e.g. your
// personal stage). There is no default.
//
// `check` exits 0 when access is enabled, 2 when disabled.
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running. No AWS_REGION configuration is needed: the region is
// us-east-2 for production/staging (see sst.config.ts); for dev stages it is
// read from the table ARN in `sst state export`.

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { execFileSync } from 'node:child_process';

const USAGE = 'Usage: node bin/rag-access.ts <enable|disable|check> <stage> <email>';

const command = process.argv[2];
const stage = process.argv[3];
const emailArg = process.argv[4];

if (!command || !stage || !emailArg) {
  console.error(USAGE);
  process.exit(1);
}
if (command !== 'enable' && command !== 'disable' && command !== 'check') {
  console.error(`Unknown command: ${command}\n${USAGE}`);
  process.exit(1);
}
if (!emailArg.includes('@')) {
  console.error(`Not an email address: ${emailArg}`);
  process.exit(1);
}

// The backend lowercases the email before the allowlist lookup, so the key
// must use the lowercased form.
const email = emailArg.toLowerCase();
const isFoundationEmail = email.endsWith('@fil.org');

if (command === 'check' && isFoundationEmail) {
  console.error(
    `RAG access is ENABLED for ${email} on stage "${stage}": ` +
      '@fil.org (Foundation) emails always have access, regardless of the allowlist.',
  );
  process.exit(0);
}
if (isFoundationEmail) {
  console.error(
    'Warning: @fil.org (Foundation) emails always have RAG access — the allowlist row does not affect them.',
  );
}

// The AWS SDK resolves credentials from the profile; without it the DynamoDB
// calls fail late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      '  aws sso login --profile filone\n' +
      '  export AWS_PROFILE=filone',
  );
  process.exit(1);
}

console.error('Stage:', stage);
const { tableName, region } = findUserInfoTable(stage);
console.error(`UserInfoTable: ${tableName} (region ${region})`);

const dynamo = new DynamoDBClient({ region });

const key = { pk: { S: `ALLOWLIST#${email}` }, sk: { S: 'RAG' } };
console.error(`Allowlist key: pk=${key.pk.S} sk=${key.sk.S}`);

switch (command) {
  case 'enable':
    await enableAccess();
    break;
  case 'disable':
    await disableAccess();
    break;
  case 'check':
    await checkAccess();
    break;
}

async function enableAccess(): Promise<void> {
  // The row's existence is the grant — no other attributes are needed.
  await dynamo.send(new PutItemCommand({ TableName: tableName, Item: key }));

  // Verify the write landed before reporting success.
  if (!(await allowlistRowExists())) {
    console.error('Verification failed: the allowlist row is not readable after the put.');
    process.exit(1);
  }

  console.error(
    `RAG access enabled for ${email} on stage "${stage}". ` +
      'The website caches GET /me for 10 minutes — the customer may need to reload the app.',
  );
}

async function disableAccess(): Promise<void> {
  const { Attributes } = await dynamo.send(
    new DeleteItemCommand({ TableName: tableName, Key: key, ReturnValues: 'ALL_OLD' }),
  );

  if (Attributes) {
    console.error(`RAG access disabled for ${email} on stage "${stage}".`);
  } else {
    console.error(
      `${email} was not on the RAG allowlist for stage "${stage}" — nothing to delete.`,
    );
  }
}

async function checkAccess(): Promise<void> {
  if (await allowlistRowExists()) {
    console.error(`RAG access is ENABLED for ${email} on stage "${stage}" (allowlist row exists).`);
    process.exit(0);
  }
  console.error(`RAG access is DISABLED for ${email} on stage "${stage}" (no allowlist row).`);
  process.exit(2);
}

async function allowlistRowExists(): Promise<boolean> {
  const { Item } = await dynamo.send(
    new GetItemCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  return Item !== undefined;
}

function findUserInfoTable(stage: string): { tableName: string; region: string } {
  // The SST `UserInfoTable` Dynamo component creates a single underlying table
  // whose URN ends with `::UserInfoTableTable`.
  const json = execFileSync('pnpm', ['exec', 'sst', 'state', 'export', '--stage', stage], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const resources: Array<{ type: string; urn: string; outputs?: { name?: string; arn?: string } }> =
    JSON.parse(json).latest?.resources ?? [];

  const table = resources.find(
    (r) => r.type === 'aws:dynamodb/table:Table' && r.urn.endsWith('::UserInfoTableTable'),
  );

  if (!table?.outputs?.name) {
    console.error(`Could not find UserInfoTable in SST state for stage "${stage}".`);
    process.exit(1);
  }

  return { tableName: table.outputs.name, region: resolveRegion(stage, table.outputs.arn) };
}

function resolveRegion(stage: string, tableArn: string | undefined): string {
  // The deployment home region is fixed for production/staging (see
  // sst.config.ts); dev stages can deploy anywhere, so read the region from
  // the table ARN (arn:aws:dynamodb:<region>:<account>:table/<name>).
  if (stage === 'production' || stage === 'staging') return 'us-east-2';

  const region = tableArn?.split(':')[3];
  if (!region) {
    console.error(`Could not parse the region from the table ARN: ${tableArn}`);
    process.exit(1);
  }
  return region;
}
