#!/usr/bin/env node

// Create a pre-signed GetObject URL for a customer object stored in the Aurora
// region (eu-west-1), valid for 24 hours, and print a billing report for the
// account owning the tenant: Stripe dashboard link for the customer record,
// subscription status (trial? payment method on file?), and the latest usage
// numbers (stored bytes, egress) from the usage-reporting audit trail.
//
// Usage:
//   node bin/aurora-preview-url.ts <auroraTenantId> <bucket> <objectKey>
//   node bin/aurora-preview-url.ts f6d6ca47-d220-4da4-b2c5-87f5ae838ce8 amazon-ese VerifiedSNew.html
//
// The tenant id is Aurora's, not the Fil One org id — take it from the Aurora
// Back Office dashboard, or map an org id to it with bin/aurora-s3-env.ts.
// For the billing report, the tenant id is mapped back to the org id by
// scanning UserInfoTable for the PROFILE record with a matching
// auroraTenantId. (Aurora does not report our org id back: its GET-tenant
// response carries the display name in `name` and leaves `orgId` unset.)
//
// The stage defaults to `production`; set STAGE to target another one. The
// object key is passed through verbatim, so a leading slash is preserved.
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running. Table names come from `sst state export`. The billing report
// reads DynamoDB only (never the Stripe API) and is best-effort — failures
// print a warning and the preview URL is still produced.
//
// The URL is bearer authority for its whole lifetime: anyone holding it can
// read the object until it expires.

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execFileSync } from 'node:child_process';

const USAGE = 'Usage: node bin/aurora-preview-url.ts <auroraTenantId> <bucket> <objectKey>';

const EXPIRES_IN_SECONDS = 24 * 60 * 60;

const tenantId = process.argv[2];
const bucketName = process.argv[3];
const objectKey = process.argv[4];

if (!tenantId || !bucketName || !objectKey) {
  console.error(USAGE);
  process.exit(1);
}

const stage = process.env.STAGE ?? 'production';
const isProduction = stage === 'production';

// The AWS SDK resolves credentials from the profile; without it the SSM call
// fails late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  const profile = isProduction ? 'filone-production' : 'filone-sandbox';
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      `  aws sso login --profile ${profile}\n` +
      `  export AWS_PROFILE=${profile}`,
  );
  process.exit(1);
}
console.error(`Stage: ${stage}`);
console.error(`Tenant ID: ${tenantId}`);
console.error(`Bucket: ${bucketName}`);

// The deployment home region is fixed for production/staging (see
// sst.config.ts); dev stages can deploy anywhere.
const controlPlaneRegion =
  stage === 'production' || stage === 'staging'
    ? 'us-east-2'
    : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');

const dynamo = new DynamoDBClient({ region: controlPlaneRegion });

// The billing report is best-effort: a half-provisioned account must not stop
// us from producing the preview URL.
try {
  await printBillingReport();
} catch (err) {
  console.error('Warning: could not produce the billing report:', err);
}

const url = await presignGetObject();
console.error(`Expires: ${new Date(Date.now() + EXPIRES_IN_SECONDS * 1000).toISOString()}`);
console.log(url);

async function printBillingReport(): Promise<void> {
  const { userInfoTable, billingTable } = findTableNames(stage);

  const profile = await findOrgProfileByTenantId(userInfoTable, tenantId);
  if (!profile) {
    console.error(`No org with auroraTenantId "${tenantId}" found in ${userInfoTable}.`);
    return;
  }
  const orgId = String(profile.pk).replace(/^ORG#/, '');
  const userId = profile.createdBy;
  console.error('');
  console.error('=== Account ===');
  console.error(`Org ID: ${orgId}`);
  if (profile.name) console.error(`Org name: ${formatValue(profile.name)}`);
  console.error(`Owner user ID: ${typeof userId === 'string' ? userId : '(missing createdBy)'}`);

  let subscription: Record<string, unknown> | null = null;
  if (typeof userId === 'string') {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: billingTable,
        Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
      }),
    );
    subscription = Item ? unmarshall(Item) : null;
  }

  console.error('');
  console.error('=== Subscription (BillingTable) ===');
  if (!subscription) {
    console.error('No subscription record — the account holds no entitlement.');
  } else {
    printFields(subscription, [
      'subscriptionStatus',
      'subscriptionId',
      'stripeCustomerId',
      'trialEndsAt',
      'gracePeriodEndsAt',
      'currentPeriodEnd',
      'canceledAt',
      'lastPaymentFailedAt',
      'updatedAt',
    ]);
    const hasPaymentMethod = Boolean(
      subscription.paymentMethodId || subscription.paymentMethodLast4,
    );
    console.error(`Payment method on file: ${hasPaymentMethod ? 'yes' : 'no'}`);

    if (typeof subscription.stripeCustomerId === 'string') {
      // No account id in the path — the dashboard opens the customer under
      // whichever Stripe account you are logged into, so make sure it is the
      // right one. (Resolving the acct_... id would require the Stripe API.)
      console.error(
        `Stripe dashboard: https://dashboard.stripe.com/customers/${subscription.stripeCustomerId}`,
      );
    }
  }

  await printLatestUsageReport(billingTable, orgId);
}

// The org PROFILE record is keyed by orgId and Aurora does not report our org
// id back (its GET-tenant response carries the display name in `name` and
// leaves `orgId` unset), so mapping an Aurora tenant id back to its org takes
// a paginated scan. FilterExpression is applied after each page is read, so a
// page can legitimately match nothing while more pages remain.
async function findOrgProfileByTenantId(
  userInfoTable: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await dynamo.send(
      new ScanCommand({
        TableName: userInfoTable,
        FilterExpression: 'sk = :profile AND auroraTenantId = :tenantId',
        ExpressionAttributeValues: {
          ':profile': { S: 'PROFILE' },
          ':tenantId': { S: tenantId },
        },
        ExclusiveStartKey: exclusiveStartKey as never,
      }),
    );
    if (Items?.[0]) return unmarshall(Items[0]);
    exclusiveStartKey = LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}

async function printLatestUsageReport(billingTable: string, orgId: string): Promise<void> {
  // The usage-reporting worker writes one audit record per org per day — see
  // writeUsageAuditRecord in packages/backend/src/jobs/usage-reporting-worker.ts.
  const { Items } = await dynamo.send(
    new QueryCommand({
      TableName: billingTable,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':sk': { S: 'USAGE_REPORT#' },
      },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  console.error('');
  console.error('=== Latest usage report (BillingTable) ===');
  const report = Items?.[0] ? unmarshall(Items[0]) : null;
  if (!report) {
    console.error('No USAGE_REPORT records — the usage worker has not run for this org yet.');
    return;
  }
  console.error(`Report date: ${formatValue(report.reportDate)}`);
  console.error(`Average storage this period: ${formatBytes(report.averageStorageBytesUsed)}`);
  console.error(`Total egress this period: ${formatBytes(report.totalEgressBytes)}`);
  printFields(report, [
    'subscriptionStatus',
    'currentPeriodStart',
    'sampleCount',
    'reportedToStripe',
    'lockAction',
    'orgSyncAction',
  ]);
}

// SST gives tables physical names like `filone-<stage>-BillingTableTable-<random>`.
// Without `sst shell` we can't resolve the SST link, so read the names out of
// the exported SST state (`sst state export` works in production — it doesn't
// evaluate providers).
function findTableNames(stage: string): { userInfoTable: string; billingTable: string } {
  const json = execFileSync('pnpm', ['exec', 'sst', 'state', 'export', '--stage', stage], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const resources: Array<{ type: string; urn: string; outputs?: { name?: string } }> =
    JSON.parse(json).latest?.resources ?? [];

  const findTable = (urnSuffix: string): string => {
    const table = resources.find(
      (r) => r.type === 'aws:dynamodb/table:Table' && r.urn.endsWith(urnSuffix),
    );
    if (!table?.outputs?.name) {
      throw new Error(`Could not find ${urnSuffix} in SST state for stage "${stage}".`);
    }
    return table.outputs.name;
  };

  return {
    userInfoTable: findTable('::UserInfoTableTable'),
    billingTable: findTable('::BillingTableTable'),
  };
}

function printFields(record: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (record[field] !== undefined) console.error(`${field}: ${formatValue(record[field])}`);
  }
}

function formatValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return String(bytes);
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB (${Math.round(bytes)} bytes)`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB (${Math.round(bytes)} bytes)`;
  return `${Math.round(bytes)} bytes`;
}

async function presignGetObject(): Promise<string> {
  // Bin scripts must not import from @filone/shared, so the Aurora endpoints
  // are inlined — keep them in sync with getS3Endpoint in
  // packages/shared/src/constants.ts.
  const endpoint = isProduction ? 'https://eu-west-1.s3.fil.one' : 'https://s3.dev.aur.lu';
  console.error('');
  console.error(`Endpoint: ${endpoint}`);

  const s3 = new S3Client({
    endpoint,
    // Aurora signs with "auto"; the signing region is part of the signature, so
    // any other value produces URLs that 403.
    region: 'auto',
    credentials: await readConsoleS3Credentials(),
    forcePathStyle: true,
    // Match packages/backend/src/lib/s3-client.ts: no auto-added CRC32 checksum
    // params in the signed query string.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  // Fail fast on a wrong key: presigning is a local signature computation and
  // would happily produce a URL that 404s when opened.
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }));
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      console.error(`Object "${objectKey}" does not exist in bucket "${bucketName}".`);
      process.exit(1);
    }
    // The gateway may restrict HEAD for this key; presign anyway.
    console.error('Warning: could not verify the object exists (HeadObject failed):', err);
  }

  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: objectKey }), {
    expiresIn: EXPIRES_IN_SECONDS,
  });
}

// The console's S3 access key for the tenant, stashed during tenant setup — see
// packages/backend/src/lib/s3-credentials.ts for the path scheme.
async function readConsoleS3Credentials(): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
}> {
  const ssm = new SSMClient({ region: controlPlaneRegion });

  const parameterName = `/filone/${stage}/aurora-s3/access-key/${tenantId}`;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    value = Parameter?.Value;
  } catch (err) {
    // A wrong or non-Aurora tenant id is the most likely user error now that
    // the tenant id is a raw argument.
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      console.error(
        `No S3 credentials found in SSM at ${parameterName} — ` +
          `is "${tenantId}" an Aurora tenant id on stage "${stage}"?`,
      );
      process.exit(1);
    }
    throw err;
  }
  if (!value) {
    console.error(`No S3 credentials found in SSM at ${parameterName}.`);
    process.exit(1);
  }

  return JSON.parse(value);
}
