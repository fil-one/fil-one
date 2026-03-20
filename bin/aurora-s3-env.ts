#!/usr/bin/env node

// Fetch Aurora S3 credentials for a given orgId and print export statements.
// Usage: eval "$(node bin/aurora-s3-env.ts <orgId>)"

import { execFileSync } from 'node:child_process';

const orgId = process.argv[2];
if (!orgId) {
  console.error('Usage: eval "$(node bin/aurora-s3-env.ts <orgId>)"');
  process.exit(1);
}

// Re-exec under `sst shell` if SST resources aren't available
if (!process.env.SST_RESOURCE_App) {
  execFileSync('pnpx', ['sst', 'shell', 'node', import.meta.filename, orgId], {
    stdio: 'inherit',
  });
  process.exit(0);
}

import { Resource } from 'sst';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { readFileSync } from 'node:fs';

const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

// Fetch auroraTenantId from DynamoDB
const { Item } = await dynamo.send(
  new GetItemCommand({
    TableName: Resource.UserInfoTable.name,
    Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
  }),
);

const tenantId = Item?.auroraTenantId?.S;
if (!tenantId) {
  console.error(`No auroraTenantId found for org ${orgId}`);
  process.exit(1);
}
console.error(`Tenant ID: ${tenantId}`);

// Fetch S3 credentials from SSM
const { Parameter } = await ssm.send(
  new GetParameterCommand({
    Name: `/filone/${stage}/aurora-s3/access-key/${tenantId}`,
    WithDecryption: true,
  }),
);

if (!Parameter?.Value) {
  console.error(`No Aurora S3 credentials found in SSM for tenant ${tenantId}`);
  process.exit(1);
}

const { accessKeyId, secretAccessKey } = JSON.parse(Parameter.Value);

console.log(`export AWS_ENDPOINT_URL=https://s3.dev.aur.lu`);
console.log(`export AWS_ACCESS_KEY_ID=${accessKeyId}`);
console.log(`export AWS_SECRET_ACCESS_KEY=${secretAccessKey}`);
