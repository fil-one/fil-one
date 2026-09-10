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
//   node bin/fth-console-key.ts repair <stage> [--org <orgId>] [--dry-run]
//
//   node bin/fth-console-key.ts rotate staging --dry-run
//   node bin/fth-console-key.ts rotate staging
//   node bin/fth-console-key.ts prune  staging
//
// Run `rotate` after the backend change is deployed, and `prune` only once
// every container that started before the rotation is gone. Lambda containers
// cache the SSM value for their whole lifetime (getConsoleS3Credentials in
// packages/backend/src/lib/s3-credentials.ts has no TTL), so a warm container
// keeps signing with the v1 key until it recycles; the next deploy replaces
// them all. Both keys are valid until the prune, so nothing fails in between.
// While both exist, each tenant holds one extra key: it counts against the
// tenant's key limit, and the console's usage view undercounts the customer's
// own keys by one.
//
// A tenant already at its access-key limit has nowhere to put the second key,
// and FTH rejects the create. `rotate` reports that tenant with the error FTH
// returned and moves on to the next one.
//
// `rotate` skips an org whose SSM-referenced key already carries the three
// actions, so re-runs and tenants provisioned after the change are cheap.
//
// `rotate` writes SSM only after the new key answers a GET on its id and signs
// an S3 ListBuckets. FTH answering the create with a 201 is not evidence the
// key exists (see `repair` below), and a tenant whose verification fails keeps
// signing with the key it already has.
//
// Every create carries an idempotency key that is fresh for the attempt. The
// first version of this command derived one from the tenant id, and a re-run
// then had FTH replay the stored 201 of the earlier create, handing back the
// accessKeyId of a key the re-run had just deleted. A create FTH already
// committed comes back as a name conflict, so nothing is lost by giving up the
// replay.
//
// `prune` deletes v1 only for a tenant whose SSM-referenced key exists in FTH
// and carries the three actions. Any other state means the rotation has not
// landed for that tenant: it keeps its working v1 key, is reported, and makes
// the command exit non-zero.
//
// `repair` handles one specific failure, seen in production on 2026-09-01: FTH
// answered the create with a 201 and an accessKeyId, `rotate` wrote those
// credentials to SSM, and the key does not exist. It is absent from the
// tenant's key listing, a GET on the id returns 404, and it cannot sign an S3
// request. The console keeps working only until the Lambda containers that
// cached the pre-rotation credentials recycle.
//
// The v1 secret cannot be recovered (FTH returns a secret only on create), so
// the repair is a new key. `repair` acts only on a tenant whose SSM-referenced
// id FTH answers with a 404, creates a key named
// `filone-console-v2-fix-<random>` under a matching idempotency key, and writes
// SSM only after the new key answers a GET and signs an S3 ListBuckets. The
// random suffix keeps the name off whatever state the failed create left behind
// at FTH, which is what `rotate` cannot get past for such a tenant: it always
// asks for the name `filone-console-v2`. `CreateAccessKeySchema` reserves the
// whole `filone-console` prefix, so no customer key can hold either name.
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

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { PutParameterCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createFthManagementApi,
  type FthAccessKey,
  type FthAccessKeyWithSecret,
} from './lib/fth-management.ts';
import { findTable } from './lib/sst-state.ts';

const USAGE =
  'Usage: node bin/fth-console-key.ts <rotate|prune|repair> <stage> [--org <orgId>] [--dry-run]';

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

const command = process.argv[2];
const stage = process.argv[3];

if (command !== 'rotate' && command !== 'prune' && command !== 'repair') {
  usage(`Unknown command: ${command ?? '(none)'}`);
}
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

const { tableName, region } = findTable(stage, '::UserInfoTableTable');

// `sst state export --stage X` is the only thing that ties this run to a stage,
// so assert the resolved name matches rather than trusting the flag.
if (!tableName.includes(`filone-${stage}-`)) {
  console.error(`Stage mismatch: --stage "${stage}" but resolved table "${tableName}".`);
  process.exit(1);
}

console.error(`UserInfoTable: ${tableName} (region ${region})`);

const fth = createFthManagementApi({ baseUrl: fthBaseUrl, token: fthToken });
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
        : command === 'prune'
          ? await pruneTenant(orgId, tenantId)
          : await repairTenant(orgId, tenantId);
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
  const existingKeys = await fth.listAccessKeys(tenantId);
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
    // The name only became reserved with this change, so a customer key can
    // already carry it — and customer keys hang off the same storage user, which
    // makes the name the only thing separating them here. Our DynamoDB rows are
    // what tells the two apart: deleting a key the customer is using would break
    // their integration and leave the row pointing at nothing.
    const customerKeyIds = await findCustomerAccessKeyIds(orgId);
    if (customerKeyIds.has(staleV2.accessKeyId)) {
      throw new Error(
        `${CONSOLE_KEY_NAME_V2} (${staleV2.accessKeyId}) is a customer key on this tenant, ` +
          'not a leftover from a failed rotation. Ask the customer to rename or delete it, ' +
          'then rotate this tenant again. Nothing was changed.',
      );
    }
    console.error(
      `${label}: ${CONSOLE_KEY_NAME_V2} exists (${staleV2.accessKeyId}) but SSM points elsewhere — ` +
        'its secret is unrecoverable, deleting it.',
    );
    if (!dryRun) await fth.deleteAccessKey(tenantId, staleV2.accessKeyId);
  }

  const userId = await findConsoleStorageUserId(tenantId);

  if (dryRun) {
    console.error(
      `${label}: [dry-run] would create ${CONSOLE_KEY_NAME_V2} on storage user ${userId}, ` +
        `verify it, and repoint ${ssmParameterName(tenantId)}`,
    );
    return true;
  }

  // A tenant at its access-key limit is the expected rejection here: the v2 key
  // lives alongside v1 until the prune, so there has to be a free slot. Report
  // it with what FTH said and let the loop move on; it needs a hand-rotation
  // once the customer has freed a slot.
  const created = await createV2Key(tenantId, userId);

  // The create sends a fresh idempotency key, so FTH has nothing to replay
  // here. Getting the just-deleted id back anyway names the problem better
  // than the 404 `verifyNewKey` would report a moment later.
  if (staleV2 && created.accessKeyId === staleV2.accessKeyId) {
    throw new Error(
      `FTH returned the deleted key ${staleV2.accessKeyId} for a create under a new idempotency key. ` +
        'SSM was not written; the tenant needs a key created by hand.',
    );
  }

  await verifyNewKey(tenantId, CONSOLE_KEY_NAME_V2, created);

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
    `${label}: created ${CONSOLE_KEY_NAME_V2} (${created.accessKeyId}), verified it against the ` +
      'management API and S3, and repointed SSM. Warm Lambda containers keep using the old key ' +
      'until they recycle.',
  );
  return true;
}

/** Returns true when the v1 key was deleted for this tenant. */
async function pruneTenant(orgId: string, tenantId: string): Promise<boolean> {
  const label = `org ${orgId} (tenant ${tenantId})`;
  const currentAccessKeyId = await readSsmAccessKeyId(tenantId);
  const existingKeys = await fth.listAccessKeys(tenantId);
  const v1 = existingKeys.find((k) => k.name === CONSOLE_KEY_NAME_V1);

  if (!v1) {
    console.error(`${label}: no ${CONSOLE_KEY_NAME_V1} key — nothing to prune.`);
    return false;
  }

  // v1 is the credential that still works, so it goes only once the one
  // replacing it is real. Every way that can fail — no SSM parameter, a
  // parameter naming a key FTH no longer has, a hand-created replacement
  // without the multipart actions — is a tenant whose rotation has to happen
  // before the prune, and a failure the operator has to see.
  if (v1.accessKeyId === currentAccessKeyId) {
    throw new Error(
      `SSM still points at ${CONSOLE_KEY_NAME_V1} (${v1.accessKeyId}). Run \`rotate\` for this tenant first.`,
    );
  }
  if (!currentAccessKeyId) {
    throw new Error(
      `${ssmParameterName(tenantId)} holds no accessKeyId, so the console has no replacement key. ` +
        `Run \`rotate\` for this tenant first.`,
    );
  }
  const currentKey = existingKeys.find((k) => k.accessKeyId === currentAccessKeyId);
  if (!currentKey) {
    throw new Error(
      `SSM points at ${currentAccessKeyId}, which FTH does not list for this tenant. ` +
        `Run \`rotate\` for this tenant first.`,
    );
  }
  if (!hasMultipartActions(currentKey)) {
    throw new Error(
      `SSM points at ${currentKey.name} (${currentAccessKeyId}), which lacks the multipart actions. ` +
        `Run \`rotate\` for this tenant first.`,
    );
  }

  if (dryRun) {
    console.error(`${label}: [dry-run] would delete ${CONSOLE_KEY_NAME_V1} (${v1.accessKeyId})`);
    return true;
  }

  await fth.deleteAccessKey(tenantId, v1.accessKeyId);
  console.error(`${label}: deleted ${CONSOLE_KEY_NAME_V1} (${v1.accessKeyId}).`);
  return true;
}

/**
 * Returns true when a replacement key was created for this tenant.
 *
 * Narrow on purpose: the only state it acts on is SSM naming a key FTH answers
 * with a 404. Every other shape of "not rotated" is `rotate`'s job, and the v1
 * key still works in all of them.
 */
async function repairTenant(orgId: string, tenantId: string): Promise<boolean> {
  const label = `org ${orgId} (tenant ${tenantId})`;
  const currentAccessKeyId = await readSsmAccessKeyId(tenantId);
  if (!currentAccessKeyId) {
    console.error(
      `${label}: ${ssmParameterName(tenantId)} holds no accessKeyId — run \`rotate\` for this tenant.`,
    );
    return false;
  }

  const existingKeys = await fth.listAccessKeys(tenantId);
  const currentKey = existingKeys.find((k) => k.accessKeyId === currentAccessKeyId);
  if (currentKey) {
    console.error(
      hasMultipartActions(currentKey)
        ? `${label}: SSM points at ${currentKey.name} (${currentAccessKeyId}), which FTH lists — nothing to repair.`
        : `${label}: SSM points at ${currentKey.name} (${currentAccessKeyId}), which lacks the multipart actions — run \`rotate\` for this tenant.`,
    );
    return false;
  }

  // Absence from the listing is not enough on its own — a truncated page looks
  // the same. Only a 404 on the id says FTH has no such key.
  if (await fth.accessKeyExists(tenantId, currentAccessKeyId)) {
    console.error(
      `${label}: FTH has ${currentAccessKeyId} but leaves it out of the tenant's listing. ` +
        'The console credential works, so nothing is repaired here; `prune` cannot verify this tenant.',
    );
    return false;
  }

  if (dryRun) {
    console.error(
      `${label}: [dry-run] SSM points at ${currentAccessKeyId}, which FTH does not have. Would create ` +
        `${CONSOLE_KEY_NAME_V2}-fix-<random>, verify it, and repoint ${ssmParameterName(tenantId)}.`,
    );
    return true;
  }

  const keyName = `${CONSOLE_KEY_NAME_V2}-fix-${randomBytes(3).toString('hex')}`;
  const userId = await findConsoleStorageUserId(tenantId);
  const created = await createRepairKey(tenantId, userId, keyName);

  await verifyNewKey(tenantId, keyName, created);

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
    `${label}: created ${keyName} (${created.accessKeyId}), verified it against the management API ` +
      'and S3, and repointed SSM. Warm Lambda containers keep using their cached credentials until they recycle.',
  );

  // `prune` matches the SSM-referenced key against the listing, so a key FTH
  // holds but does not list leaves this tenant unprunable.
  const relisted = await fth.listAccessKeys(tenantId);
  if (!relisted.some((k) => k.accessKeyId === created.accessKeyId)) {
    console.error(
      `${label}: the new key is missing from the tenant's key listing. The console works; ` +
        '`prune` will refuse this tenant until FTH lists it.',
    );
  }
  return true;
}

// ── FTH API ─────────────────────────────────────────────────────

async function findConsoleStorageUserId(tenantId: string): Promise<string> {
  const users = await fth.listStorageUsers(tenantId);
  const user = users.find((u) => u.userCode === CONSOLE_USER_CODE);
  if (!user) {
    throw new Error(`No storage user with userCode "${CONSOLE_USER_CODE}" on tenant ${tenantId}`);
  }
  return String(user.id);
}

// The loop's catch prefixes org and tenant, so this only has to say what
// failed and what the operator does about it.
async function createV2Key(tenantId: string, userId: string): Promise<FthAccessKeyWithSecret> {
  try {
    return await fth.createAccessKey(tenantId, userId, {
      name: CONSOLE_KEY_NAME_V2,
      permissions: FTH_FULL_PERMISSIONS,
      // Fresh on every attempt. A key reused across runs made FTH replay the
      // stored 201 of an earlier create — including the accessKeyId of a key
      // this command had since deleted, which is how production ended up
      // pointing at credentials nobody holds. Nothing needs the replay:
      // access-key names are unique within a tenant, so a create FTH already
      // committed comes back as a name conflict instead of a second key.
      idempotencyKey: `console-key-v2-${tenantId}-${randomBytes(4).toString('hex')}`,
    });
  } catch (err) {
    throw new Error(
      `could not create ${CONSOLE_KEY_NAME_V2} — ${formatError(err)}. ` +
        'Rotate this tenant by hand once the cause is cleared.',
    );
  }
}

async function createRepairKey(
  tenantId: string,
  userId: string,
  keyName: string,
): Promise<FthAccessKeyWithSecret> {
  try {
    return await fth.createAccessKey(tenantId, userId, {
      name: keyName,
      permissions: FTH_FULL_PERMISSIONS,
      // Derived from the random name, so no repair run can replay another
      // one's response. `console-key-v2-<tenantId>` is the record that hands
      // back the phantom key and must not be reused here.
      idempotencyKey: `console-key-repair-${keyName}`,
    });
  } catch (err) {
    throw new Error(`could not create ${keyName} — ${formatError(err)}. SSM was not written.`);
  }
}

/**
 * Throws unless the key FTH says it created is real and can sign. A create that
 * reports success and persists nothing is the production failure of
 * 2026-09-01, and a 201 is not evidence on its own: the id has to answer a GET
 * and the credentials have to sign an S3 request before the console is pointed
 * at them.
 */
async function verifyNewKey(
  tenantId: string,
  keyName: string,
  created: FthAccessKeyWithSecret,
): Promise<void> {
  if (!created.accessKeyId || !created.secretAccessKey) {
    throw new Error('FTH returned no credentials for the new key; SSM was not written.');
  }
  if (!(await fth.accessKeyExists(tenantId, created.accessKeyId))) {
    throw new Error(
      `FTH created ${keyName} (${created.accessKeyId}) and then 404s on it. SSM was not written; ` +
        'the tenant keeps signing with the key it has. Report the id to FTH before retrying ' +
        'this tenant.',
    );
  }
  await verifyS3Access(keyName, created);
}

// ── S3 data plane ───────────────────────────────────────────────

/**
 * Signs one request with the new credentials. The management API answering a
 * GET is not proof the key reached the S3 gateway, and a key that cannot sign
 * is the whole failure this verification exists for.
 */
async function verifyS3Access(keyName: string, key: FthAccessKeyWithSecret): Promise<void> {
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: getFthS3Endpoint(stage),
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey },
  });

  // A fresh key takes a moment to propagate to the gateway; a valid key lists
  // buckets, an unknown one is denied.
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await s3.send(new ListBucketsCommand({}));
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(
          `${keyName} (${key.accessKeyId}) cannot sign an S3 request after ${attempts} attempts — ` +
            `${formatError(err)}. SSM was not written.`,
        );
      }
      await sleep(2000);
    }
  }
}

// Mirrors getS3Endpoint(S3Region.UsEast1, stage) in
// packages/shared/src/constants.ts, as bin/fth-s3-env.ts does.
function getFthS3Endpoint(stage: string): string {
  return stage === 'production'
    ? 'https://s3.us-east-1.filonecontent.com'
    : 'https://s3.us-east-1.staging.filonecontent.com';
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
 * The accessKeyIds of the org's customer-issued keys, from our own DynamoDB
 * rows (`ORG#<orgId>` / `ACCESSKEY#<id>`, written by the create-access-key
 * handler). The console key was never among them, so anything in here belongs
 * to the customer.
 */
async function findCustomerAccessKeyIds(orgId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `ORG#${orgId}` },
          ':skPrefix': { S: 'ACCESSKEY#' },
        },
        ProjectionExpression: 'accessKeyId',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const id = item.accessKeyId?.S;
      if (id) ids.add(id);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return ids;
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
