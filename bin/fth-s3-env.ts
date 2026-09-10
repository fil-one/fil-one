#!/usr/bin/env node

// Fetch FTH (us-east-1) S3 credentials for a given orgId and print export
// statements.
//
// Usage:
//   eval "$(node bin/fth-s3-env.ts <orgId> [stage])"
//
// Unlike bin/aurora-s3-env.ts, this script does NOT shell out to `sst shell`,
// so it works in production (where `sst shell` can't evaluate the pulumi
// providers). It talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running.
//
//   stage      defaults to "production"; pass e.g. "staging" to override.

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { findTable } from './lib/sst-state.ts';

const orgId = process.argv[2];
const stage = process.argv[3] ?? 'production';
if (!orgId) {
  console.error('Usage: eval "$(node bin/fth-s3-env.ts <orgId> [stage])"');
  process.exit(1);
}

// SST gives the table a physical name like
// `filone-<stage>-UserInfoTableTable-<random>`. Without `sst shell` we can't
// resolve the SST link, so read the name out of the exported SST state
// (`sst state export` works in production — it doesn't evaluate providers).
const { tableName, region: stageRegion } = findTable(stage, '::UserInfoTableTable');
console.error(`UserInfoTable: ${tableName} (region ${stageRegion})`);

// DynamoDB and SSM live in the region of the table SST deployed, which is not
// the FTH S3 region (us-east-1). Ambient AWS_REGION cannot override it: this
// script exports AWS_REGION=us-east-1 for the S3 client, so honouring it would
// send the next invocation in the same shell to a region with no table.
const dynamo = new DynamoDBClient({ region: stageRegion });
const ssm = new SSMClient({ region: stageRegion });

// Fetch fthTenantId from DynamoDB
const { Item } = await dynamo.send(
  new GetItemCommand({
    TableName: tableName,
    Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
  }),
);

const tenantId = Item?.fthTenantId?.S;
if (!tenantId) {
  console.error(`No fthTenantId found for org ${orgId}`);
  process.exit(1);
}
console.error(`Tenant ID: ${tenantId}`);

// Fetch S3 credentials from SSM
const { Parameter } = await ssm.send(
  new GetParameterCommand({
    Name: `/filone/${stage}/fth-s3/access-key/${tenantId}`,
    WithDecryption: true,
  }),
);

if (!Parameter?.Value) {
  console.error(`No FTH S3 credentials found in SSM for tenant ${tenantId}`);
  process.exit(1);
}

const { accessKeyId, secretAccessKey } = JSON.parse(Parameter.Value);

console.log(`export AWS_ENDPOINT_URL=${getFthS3Endpoint(stage)}`);
console.log(`export AWS_REGION=us-east-1`);
console.log(`export AWS_ACCESS_KEY_ID=${accessKeyId}`);
console.log(`export AWS_SECRET_ACCESS_KEY=${secretAccessKey}`);

// Mirrors getS3Endpoint(S3Region.UsEast1, stage) in
// packages/shared/src/constants.ts. Inlined to keep this script free of
// application source imports.
function getFthS3Endpoint(stage: string): string {
  return stage === 'production'
    ? 'https://s3.us-east-1.filonecontent.com'
    : 'https://s3.us-east-1.staging.filonecontent.com';
}
