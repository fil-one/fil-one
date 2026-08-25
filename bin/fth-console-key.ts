#!/usr/bin/env node

// Re-issue the per-tenant FTH console access key so it carries the
// multipart-upload actions.
//
// The console talks to FTH S3 with one system key per tenant, created during
// tenant setup and stashed at /filone/<stage>/fth-s3/access-key/<tenantId> —
// see packages/backend/src/lib/fth/fth-tenant-setup.ts. Keys minted before the
// multipart change lack s3:ListBucketMultipartUploads,
// s3:AbortMultipartUpload and s3:ListMultipartUploadParts, and FTH requires
// access-key names to be unique within a tenant, so the key cannot be replaced
// in place. `rotate` creates a second key named `filone-console-v2` and points
// SSM at it; `prune` deletes the old `filone-console` key afterwards.
//
// Usage:
//   node bin/fth-console-key.ts rotate <stage> [--org <orgId>] [--dry-run]
//   node bin/fth-console-key.ts prune  <stage> [--org <orgId>] [--dry-run]
//
//   node bin/fth-console-key.ts rotate staging --dry-run
//   node bin/fth-console-key.ts rotate staging
//   node bin/fth-console-key.ts prune  staging
//
// Run `prune` days after `rotate`. Lambda containers cache the SSM value for
// their whole lifetime (getConsoleS3Credentials in
// packages/backend/src/lib/s3-credentials.ts has no TTL), so a warm container
// keeps signing with the v1 key until it recycles. Both keys are valid until
// the prune, so nothing fails in between. While both exist, each tenant holds
// one extra key: it counts against the tenant's key limit, and the console's
// usage view undercounts the customer's own keys by one.
//
// `rotate` skips an org whose SSM-referenced key already carries the three
// actions, so re-runs and tenants provisioned after the change are cheap.
//
// Environment:
//   FTH_MANAGEMENT_API_URL    base URL of the FTH management API
//   FTH_MANAGEMENT_API_TOKEN  bearer token; read it from the stage's secrets
//                             with `pnpm exec sst secret list --stage <stage>`
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running. Resource names come from `sst state export`.
//
// OPEN ITEM for the production run: `rotate` writes SSM (PutParameter), and
// production logins have been read-only so far. Sort out write credentials for
// the prod account before running it there; `--dry-run` and `prune`'s read
// phase work read-only.

import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { PutParameterCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { execFileSync } from 'node:child_process';

const USAGE =
  'Usage: node bin/fth-console-key.ts <rotate|prune> <stage> [--org <orgId>] [--dry-run]';

// Inlined from packages/backend/src/lib/fth/fth-tenant-setup.ts — bin scripts
// must not import from the backend or @filone/shared. Keep in sync with
// FTH_FULL_PERMISSIONS there.
const FTH_FULL_PERMISSIONS = [
  's3:CreateBucket',
  's3:ListAllMyBuckets',
  's3:DeleteBucket',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetBucketObjectLockConfiguration',
  's3:PutBucketObjectLockConfiguration',
  's3:GetObjectRetention',
  's3:PutObjectRetention',
  's3:GetObjectLegalHold',
  's3:PutObjectLegalHold',
  's3:GetObjectVersion',
  's3:ListObjectVersions',
  's3:ListBucketMultipartUploads',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
];

// The three actions that decide whether a key needs rotating.
const MULTIPART_ACTIONS = [
  's3:ListBucketMultipartUploads',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
];

// FTH_CONSOLE_KEY_NAME and FTH_CONSOLE_USER_CODE in the backend. Keep in sync.
const CONSOLE_KEY_NAME_V1 = 'filone-console';
const CONSOLE_KEY_NAME_V2 = 'filone-console-v2';
const CONSOLE_USER_CODE = 'filone-console';

interface FthStorageUser {
  id: string;
  userCode: string;
}

interface FthAccessKey {
  id?: string;
  accessKeyId: string;
  name: string;
  permissions: string[];
}

interface FthAccessKeyWithSecret extends FthAccessKey {
  secretAccessKey: string;
}

const command = process.argv[2];
const stage = process.argv[3];

if (command !== 'rotate' && command !== 'prune') usage(`Unknown command: ${command ?? '(none)'}`);
if (!stage || stage.startsWith('--')) usage('Missing <stage>.');

const orgFilter = readFlag('org');
const dryRun = process.argv.includes('--dry-run');

const fthBaseUrl = process.env.FTH_MANAGEMENT_API_URL;
const fthToken = process.env.FTH_MANAGEMENT_API_TOKEN;
if (!fthBaseUrl || !fthToken) {
  console.error(
    'FTH_MANAGEMENT_API_URL and FTH_MANAGEMENT_API_TOKEN must both be set.\n' +
      `Read the token from the stage's secrets:\n` +
      `  pnpm exec sst secret list --stage ${stage}`,
  );
  process.exit(1);
}

// The AWS SDK resolves credentials from the profile; without it the DynamoDB
// calls fail late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  const profile = stage === 'production' ? 'filone-production' : 'filone-sandbox';
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      `  aws sso login --profile ${profile}\n` +
      `  export AWS_PROFILE=${profile}`,
  );
  process.exit(1);
}

console.error(`Command: ${command}${dryRun ? ' (dry run)' : ''}`);
console.error(`Stage: ${stage}`);
console.error(`FTH API: ${fthBaseUrl}`);

const { tableName, region } = findUserInfoTable(stage);

// `sst state export --stage X` is the only thing that ties this run to a stage,
// so assert the resolved name matches rather than trusting the flag.
if (!tableName.includes(`filone-${stage}-`)) {
  console.error(`Stage mismatch: --stage "${stage}" but resolved table "${tableName}".`);
  process.exit(1);
}

console.error(`UserInfoTable: ${tableName} (region ${region})`);

const dynamo = new DynamoDBClient({ region });
const ssm = new SSMClient({ region });

const tenants = await findFthTenants();
console.error(`FTH tenants to process: ${tenants.length}`);

let changed = 0;
let skipped = 0;
let failed = 0;

for (const { orgId, tenantId } of tenants) {
  try {
    const didChange =
      command === 'rotate'
        ? await rotateTenant(orgId, tenantId)
        : await pruneTenant(orgId, tenantId);
    if (didChange) changed++;
    else skipped++;
  } catch (err) {
    failed++;
    console.error(`org ${orgId} (tenant ${tenantId}): FAILED — ${formatError(err)}`);
  }
}

console.error(`Done. changed=${changed} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);

// ── Commands ────────────────────────────────────────────────────

/** Returns true when a new v2 key was created for this tenant. */
async function rotateTenant(orgId: string, tenantId: string): Promise<boolean> {
  const label = `org ${orgId} (tenant ${tenantId})`;
  const currentAccessKeyId = await readSsmAccessKeyId(tenantId);
  const keys = await fthRequest<{ items?: FthAccessKey[] }>(
    'GET',
    `/management/v1/clients/${encodeURIComponent(tenantId)}/access-keys`,
  );
  const existingKeys = keys.items ?? [];
  const currentKey = existingKeys.find((k) => k.accessKeyId === currentAccessKeyId);

  if (currentKey && hasMultipartActions(currentKey)) {
    console.error(`${label}: already on a key with the multipart actions — skipping.`);
    return false;
  }

  // A v2 key whose secret is not the one in SSM is unusable: FTH returns the
  // secret only on create. It can only come from a crash between the create and
  // the SSM write, so delete it and mint a fresh one.
  const staleV2 = existingKeys.find(
    (k) => k.name === CONSOLE_KEY_NAME_V2 && k.accessKeyId !== currentAccessKeyId,
  );
  if (staleV2) {
    console.error(
      `${label}: ${CONSOLE_KEY_NAME_V2} exists (${staleV2.accessKeyId}) but SSM points elsewhere — ` +
        'its secret is unrecoverable, deleting it.',
    );
    if (!dryRun) await deleteAccessKey(tenantId, staleV2);
  }

  const userId = await findConsoleStorageUserId(tenantId);

  if (dryRun) {
    console.error(
      `${label}: [dry-run] would create ${CONSOLE_KEY_NAME_V2} on storage user ${userId} ` +
        `and repoint ${ssmParameterName(tenantId)}`,
    );
    return true;
  }

  const created = await fthRequest<FthAccessKeyWithSecret>(
    'POST',
    `/management/v1/clients/${encodeURIComponent(tenantId)}/storage-users/` +
      `${encodeURIComponent(userId)}/access-keys`,
    {
      body: {
        name: CONSOLE_KEY_NAME_V2,
        permissions: FTH_FULL_PERMISSIONS,
        buckets: [],
        expiresAt: null,
      },
      // The same key the tenant-setup path sends (FTH client ids are unique
      // across the deployment all stages share), so a rotate that races setup
      // replays instead of minting a second key.
      idempotencyKey: `console-key-v2-${tenantId}`,
    },
  );

  // A replayed idempotency key would hand back the key just deleted, and
  // writing that to SSM would point the console at a dead credential.
  if (staleV2 && created.accessKeyId === staleV2.accessKeyId) {
    throw new Error(
      `FTH replayed the deleted key ${staleV2.accessKeyId} for the idempotency key. ` +
        'SSM was not written; the tenant needs a key created by hand.',
    );
  }
  if (!created.accessKeyId || !created.secretAccessKey) {
    throw new Error('FTH returned no credentials for the new key; SSM was not written.');
  }

  await ssm.send(
    new PutParameterCommand({
      Name: ssmParameterName(tenantId),
      Value: JSON.stringify({
        accessKeyId: created.accessKeyId,
        secretAccessKey: created.secretAccessKey,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  console.error(
    `${label}: created ${CONSOLE_KEY_NAME_V2} (${created.accessKeyId}) and repointed SSM. ` +
      'Warm Lambda containers keep using the old key until they recycle.',
  );
  return true;
}

/** Returns true when the v1 key was deleted for this tenant. */
async function pruneTenant(orgId: string, tenantId: string): Promise<boolean> {
  const label = `org ${orgId} (tenant ${tenantId})`;
  const currentAccessKeyId = await readSsmAccessKeyId(tenantId);
  const keys = await fthRequest<{ items?: FthAccessKey[] }>(
    'GET',
    `/management/v1/clients/${encodeURIComponent(tenantId)}/access-keys`,
  );
  const v1 = (keys.items ?? []).find((k) => k.name === CONSOLE_KEY_NAME_V1);

  if (!v1) {
    console.error(`${label}: no ${CONSOLE_KEY_NAME_V1} key — nothing to prune.`);
    return false;
  }
  if (v1.accessKeyId === currentAccessKeyId) {
    console.error(
      `${label}: SSM still points at ${CONSOLE_KEY_NAME_V1} — run \`rotate\` first, not pruning.`,
    );
    return false;
  }

  if (dryRun) {
    console.error(`${label}: [dry-run] would delete ${CONSOLE_KEY_NAME_V1} (${v1.accessKeyId})`);
    return true;
  }

  await deleteAccessKey(tenantId, v1);
  console.error(`${label}: deleted ${CONSOLE_KEY_NAME_V1} (${v1.accessKeyId}).`);
  return true;
}

// ── FTH API ─────────────────────────────────────────────────────

async function findConsoleStorageUserId(tenantId: string): Promise<string> {
  const users = await fthRequest<{ items?: FthStorageUser[] }>(
    'GET',
    `/management/v1/clients/${encodeURIComponent(tenantId)}/storage-users`,
  );
  const user = (users.items ?? []).find((u) => u.userCode === CONSOLE_USER_CODE);
  if (!user) {
    throw new Error(`No storage user with userCode "${CONSOLE_USER_CODE}" on tenant ${tenantId}`);
  }
  return String(user.id);
}

async function deleteAccessKey(tenantId: string, key: FthAccessKey): Promise<void> {
  // FTH addresses a key by its accessKeyId; `id` is present on some responses
  // and is the same value.
  await fthRequest<void>(
    'DELETE',
    `/management/v1/clients/${encodeURIComponent(tenantId)}/access-keys/` +
      `${encodeURIComponent(key.accessKeyId)}`,
  );
}

async function fthRequest<T>(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${fthToken}`,
    Accept: 'application/json',
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${fthBaseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`FTH ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ── AWS lookups ─────────────────────────────────────────────────

async function findFthTenants(): Promise<Array<{ orgId: string; tenantId: string }>> {
  if (orgFilter) {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: `ORG#${orgFilter}` }, sk: { S: 'PROFILE' } },
        ConsistentRead: true,
      }),
    );
    const tenantId = Item?.fthTenantId?.S;
    if (!tenantId) {
      console.error(`Org ${orgFilter} has no fthTenantId on stage "${stage}" — nothing to do.`);
      process.exit(1);
    }
    return [{ orgId: orgFilter, tenantId }];
  }

  const tenants: Array<{ orgId: string; tenantId: string }> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'sk = :profile AND attribute_exists(fthTenantId)',
        ExpressionAttributeValues: { ':profile': { S: 'PROFILE' } },
        ProjectionExpression: 'pk, fthTenantId',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const orgId = item.pk?.S?.replace(/^ORG#/, '');
      const tenantId = item.fthTenantId?.S;
      if (orgId && tenantId) tenants.push({ orgId, tenantId });
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return tenants;
}

/**
 * The accessKeyId the console currently signs with, or undefined when the
 * parameter is missing. The secret is never printed or returned.
 */
async function readSsmAccessKeyId(tenantId: string): Promise<string | undefined> {
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: ssmParameterName(tenantId), WithDecryption: true }),
    );
    if (!Parameter?.Value) return undefined;
    return (JSON.parse(Parameter.Value) as { accessKeyId?: string }).accessKeyId;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

function ssmParameterName(tenantId: string): string {
  return `/filone/${stage}/fth-s3/access-key/${tenantId}`;
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

// ── Helpers ─────────────────────────────────────────────────────

function hasMultipartActions(key: FthAccessKey): boolean {
  return MULTIPART_ACTIONS.every((action) => key.permissions?.includes(action));
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) usage(`Missing value for --${name}.`);
  return value;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}
