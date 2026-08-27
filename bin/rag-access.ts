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
import { findTable, requireAwsProfile } from './lib/sst-state.ts';

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

requireAwsProfile();

console.error('Stage:', stage);
const { tableName, region } = findTable(stage, '::UserInfoTableTable');
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
