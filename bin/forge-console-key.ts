#!/usr/bin/env node

// Rotate the per-tenant Forge console access key to a new version carrying the
// current CONSOLE_KEY_PERMISSIONS list.
//
// The console talks to each Forge region's S3 gateway with one service key per
// tenant, created during tenant setup and stashed at
// /filone/<stage>/<orchestratorId>-s3/access-key/<tenantId> — see
// packages/backend/src/lib/orchestrator/tenant-setup.ts. A key carries the
// permissions it was created with, so when CONSOLE_KEY_PERMISSIONS gains an
// action, keys minted before it are refused that action. The Management API
// cannot update a key and key names are unique within a tenant, so the key
// cannot be replaced in place. The key's name carries a version
// (lib/console-key-version.ts): tenant setup creates `filone-console`, version
// 1. `rotate` creates version N+1 beside the version N the console signs with
// and points SSM at it; `prune` deletes version N-1 afterwards.
//
// Usage:
//   node bin/forge-console-key.ts rotate <stage> [--region <region>] [--org <orgId>] [--only-if-missing-perms] [--dry-run]
//   node bin/forge-console-key.ts prune  <stage> [--region <region>] [--org <orgId>] [--dry-run]
//
//   node bin/forge-console-key.ts rotate staging --only-if-missing-perms --dry-run
//   node bin/forge-console-key.ts rotate staging --only-if-missing-perms
//   node bin/forge-console-key.ts prune  staging
//
// Every Forge region the stage offers is processed (getAvailableRegions in
// @filone/shared, filtered to the regions in FORGE_NETWORKS, lib/forge-network.ts), and
// `--region` narrows the run to one of them. A stage with no Forge region,
// production today, is refused before any AWS call.
//
// Run `rotate` after the backend change is deployed, and `prune` only once
// every container that started before the rotation is gone. Lambda containers
// cache the SSM value for their whole lifetime (getConsoleS3Credentials in
// packages/backend/src/lib/s3-credentials.ts has no TTL), so a warm container
// keeps signing with version N until it recycles; the next deploy replaces
// them all. Both keys are valid until the prune.
//
// `rotate` re-issues every tenant's key. With `--only-if-missing-perms` it
// skips a tenant whose SSM-referenced key already carries the full
// CONSOLE_KEY_PERMISSIONS list, so re-runs and tenants provisioned after the
// change are cheap. It refuses a tenant that still holds a console key older
// than version N, because `prune` deletes only version N-1 and the older key
// would never be cleaned up: prune that tenant first. It writes SSM only after
// the new key answers a GET on its id and signs an S3 ListBuckets (plus a
// GetBucketVersioning and a GetBucketCors when the tenant has a bucket). A
// tenant whose verification fails keeps the key it already has.
//
// The Management API takes no idempotency key on access-key creation (see
// management-openapi.yaml, "Idempotency"): a create it already committed comes
// back as a 409 on the name, so there is nothing to replay.
//
// `prune` deletes version N-1 only for a tenant whose SSM-referenced key,
// version N, exists. A tenant that signs with version 1 has nothing to prune.
// A tenant whose SSM parameter is missing or names a key the API does not have
// keeps every key, is reported, and makes the command exit non-zero.
//
// Each region's Management API URL, and the dev network's S3 endpoint override
// for a local smelt gateway, are read from the deployed AccountDeletionWorker's
// environment. The tokens come from the stage's ForgeManagementApiToken and
// ForgeDevManagementApiToken secrets via `sst secret list`; they are never
// printed. Only the regions the run covers are looked up.
//
// Talks to AWS directly using your ambient AWS credentials (no `sst shell`).
// Resource names come from `sst state export`. The role must also call
// lambda:GetFunctionConfiguration and read the stage's SST secrets.

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  GetBucketCorsCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createClient,
  deleteTenantsByTenantIdAccessKeysByAccessKeyId,
  getTenantsByTenantIdAccessKeys,
  getTenantsByTenantIdAccessKeysByAccessKeyId,
  postTenantsByTenantIdAccessKeys,
  type AccessKey,
  type Client,
  type CreatedAccessKey,
} from '@filone/orchestrator-client';
import { CONSOLE_KEY_PERMISSIONS } from '@filone/backend/src/lib/orchestrator/tenant-setup.ts';
import { ORCHESTRATOR_ID_BY_REGION } from '@filone/backend/src/lib/service-orchestrator-ids.ts';
import { getAvailableRegions, getS3Endpoint, S3Region } from '@filone/shared';
import {
  findOlderConsoleKeys,
  findPrunableConsoleKey,
  getConsoleKeyName,
  getNextConsoleKeyVersion,
} from './lib/console-key-version.ts';
import {
  FORGE_NETWORKS,
  getNetworkForRegion,
  resolveForgeApi,
  type ForgeApi,
} from './lib/forge-network.ts';
import { findTable } from './lib/sst-state.ts';
import { exportStageState } from './lib/stage.ts';

const USAGE =
  'Usage: node bin/forge-console-key.ts <rotate|prune> <stage> [--region <region>] [--org <orgId>] [--only-if-missing-perms] [--dry-run]';

interface RegionContext {
  region: S3Region;
  orchestratorId: string;
  client: Client;
  s3EndpointUrl: string;
}

const command = process.argv[2];
const stage = process.argv[3];

if (command !== 'rotate' && command !== 'prune') {
  exitWithUsage(`Unknown command: ${command ?? '(none)'}`);
}
if (!stage || stage.startsWith('--')) exitWithUsage('Missing <stage>.');

const orgFilter = readFlag('org');
const regionFilter = readFlag('region');
const dryRun = process.argv.includes('--dry-run');
const onlyIfMissingPermissions = process.argv.includes('--only-if-missing-perms');
if (onlyIfMissingPermissions && command !== 'rotate') {
  exitWithUsage('--only-if-missing-perms applies to rotate only.');
}

const stageForgeRegions = getAvailableRegions(stage).filter((r) => getNetworkForRegion(r));
if (stageForgeRegions.length === 0) {
  console.error(`Stage "${stage}" offers no Forge region. Nothing was read or written.`);
  process.exit(1);
}
if (regionFilter && !stageForgeRegions.includes(regionFilter as S3Region)) {
  exitWithUsage(
    `--region ${regionFilter} is not a Forge region on stage "${stage}" ` +
      `(Forge regions there: ${stageForgeRegions.join(', ')}).`,
  );
}
const regions = regionFilter ? [regionFilter as S3Region] : stageForgeRegions;

// The AWS SDK resolves credentials from the profile; without it the DynamoDB
// calls fail late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      '  aws sso login --profile filone-sandbox\n' +
      '  export AWS_PROFILE=filone-sandbox',
  );
  process.exit(1);
}

console.error(
  `Command: ${command}${onlyIfMissingPermissions ? ' --only-if-missing-perms' : ''}${dryRun ? ' (dry run)' : ''}`,
);
console.error(`Stage: ${stage}`);
console.error(`Regions: ${regions.join(', ')}`);

const resources = exportStageState(stage);
const { tableName, region: awsRegion } = findTable(stage, '::UserInfoTableTable', resources);

// `sst state export --stage X` is the only thing that ties this run to a stage,
// so assert the resolved name matches rather than trusting the flag.
if (!tableName.includes(`filone-${stage}-`)) {
  console.error(`Stage mismatch: --stage "${stage}" but resolved table "${tableName}".`);
  process.exit(1);
}
console.error(`UserInfoTable: ${tableName} (region ${awsRegion})`);

const dynamo = new DynamoDBClient({ region: awsRegion });
const ssm = new SSMClient({ region: awsRegion });
const lambda = new LambdaClient({ region: awsRegion });

// Every covered region's API before the first tenant, so a missing URL or
// token stops the run before it changes anything.
const forgeApis = new Map<S3Region, ForgeApi>();
for (const region of regions) {
  const network = FORGE_NETWORKS[getNetworkForRegion(region)!];
  forgeApis.set(region, await resolveForgeApi(stage, network, resources, lambda));
}

let changed = 0;
let skipped = 0;
let failed = 0;
let orgFoundInSomeRegion = false;

for (const region of regions) {
  const { baseUrl, token, s3EndpointUrl } = forgeApis.get(region)!;
  const ctx: RegionContext = {
    region,
    orchestratorId: ORCHESTRATOR_ID_BY_REGION[region],
    // Resolved lazily, so the token is not held in a long-lived config object.
    client: createClient({ baseUrl, auth: () => token }),
    s3EndpointUrl: s3EndpointUrl ?? getS3Endpoint(region, stage),
  };
  console.error(
    `── ${region} (orchestrator ${ctx.orchestratorId}, API ${baseUrl}, S3 ${ctx.s3EndpointUrl})`,
  );

  const tenants = await findTenants(ctx);
  console.error(`${region}: tenants to process: ${tenants.length}`);

  for (const { orgId, tenantId } of tenants) {
    try {
      const didChange =
        command === 'rotate'
          ? await rotateTenant(ctx, orgId, tenantId)
          : await pruneTenant(ctx, orgId, tenantId);
      if (didChange) changed++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error(`${formatLabel(ctx, orgId, tenantId)}: FAILED — ${formatError(err)}`);
    }
  }
}

if (orgFilter && !orgFoundInSomeRegion) {
  console.error(
    `Org ${orgFilter} has no Forge tenant in ${regions.join(', ')} on stage "${stage}".`,
  );
  failed++;
}

console.error(`Done. changed=${changed} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);

// ── Commands ────────────────────────────────────────────────────

/** Returns true when a new key version was created for this tenant. */
async function rotateTenant(ctx: RegionContext, orgId: string, tenantId: string): Promise<boolean> {
  const where = formatLabel(ctx, orgId, tenantId);
  const currentAccessKeyId = await readSsmAccessKeyId(ctx, tenantId);
  const currentKey = currentAccessKeyId
    ? await getAccessKey(ctx, tenantId, currentAccessKeyId)
    : undefined;

  if (onlyIfMissingPermissions && currentKey && getMissingPermissions(currentKey).length === 0) {
    console.error(`${where}: already on a key with the full permission list — skipping.`);
    return false;
  }

  const nextVersion = getNextConsoleKeyVersion(currentKey?.name);
  const nextName = getConsoleKeyName(nextVersion);
  const existingKeys = await listAccessKeys(ctx, tenantId);

  const olderKeys = findOlderConsoleKeys(existingKeys, nextVersion - 1);
  if (olderKeys.length > 0) {
    throw new Error(
      `${olderKeys.map((k) => `${k.name} (${k.accessKeyId})`).join(', ')} still exists beside ` +
        `${getConsoleKeyName(nextVersion - 1)}, and a prune after this rotation would leave it ` +
        'behind. Run `prune` for this tenant first. Nothing was changed.',
    );
  }

  // A key with the next name whose secret is not the one in SSM is unusable:
  // the API returns the secret only on create. It can only come from a crash
  // between the create and the SSM write, so delete it and mint a fresh one.
  const staleKey = existingKeys.find(
    (k) => k.type === 'service' && k.name === nextName && k.accessKeyId !== currentAccessKeyId,
  );
  if (staleKey) {
    // Our DynamoDB rows tell a customer key from a leftover; deleting a key the
    // customer is using would break their integration.
    const customerKeyIds = await findCustomerAccessKeyIds(orgId);
    if (customerKeyIds.has(staleKey.accessKeyId)) {
      throw new Error(
        `${nextName} (${staleKey.accessKeyId}) is a customer key on this tenant, ` +
          'not a leftover from a failed rotation. Nothing was changed.',
      );
    }
    console.error(
      `${where}: ${nextName} exists (${staleKey.accessKeyId}) but SSM points elsewhere — ` +
        'its secret is unrecoverable, deleting it.',
    );
    if (!dryRun) await deleteAccessKey(ctx, tenantId, staleKey.accessKeyId);
  }

  if (dryRun) {
    console.error(
      `${where}: [dry-run] would create ${nextName}, verify it, and repoint ` +
        `${getSsmParameterName(ctx, tenantId)}`,
    );
    return true;
  }

  const created = await createConsoleKey(ctx, tenantId, nextName);
  await verifyNewKey(ctx, tenantId, nextName, created);

  await ssm.send(
    new PutParameterCommand({
      Name: getSsmParameterName(ctx, tenantId),
      Value: JSON.stringify({
        accessKeyId: created.accessKeyId,
        secretAccessKey: created.secretAccessKey,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  console.error(
    `${where}: created ${nextName} (${created.accessKeyId}), verified it against the ` +
      'management API and S3, and repointed SSM. Warm Lambda containers keep using the old key ' +
      'until they recycle.',
  );
  return true;
}

/** Returns true when version N-1 was deleted for this tenant. */
async function pruneTenant(ctx: RegionContext, orgId: string, tenantId: string): Promise<boolean> {
  const where = formatLabel(ctx, orgId, tenantId);

  // Version N-1 may be the credential that still works, so it goes only once
  // the version N replacing it is real.
  const currentAccessKeyId = await readSsmAccessKeyId(ctx, tenantId);
  if (!currentAccessKeyId) {
    throw new Error(
      `${getSsmParameterName(ctx, tenantId)} holds no accessKeyId, so the console has no key. ` +
        'Run `rotate` for this tenant first.',
    );
  }
  const currentKey = await getAccessKey(ctx, tenantId, currentAccessKeyId);
  if (!currentKey) {
    throw new Error(
      `SSM points at ${currentAccessKeyId}, which the API answers with a 404. Run \`rotate\` for this tenant first.`,
    );
  }

  const previousKey = findPrunableConsoleKey(await listAccessKeys(ctx, tenantId), currentKey.name);
  if (!previousKey) {
    console.error(
      `${where}: the console signs with ${currentKey.name}; no key one version below it — nothing to prune.`,
    );
    return false;
  }

  if (dryRun) {
    console.error(
      `${where}: [dry-run] would delete ${previousKey.name} (${previousKey.accessKeyId})`,
    );
    return true;
  }

  await deleteAccessKey(ctx, tenantId, previousKey.accessKeyId);
  console.error(`${where}: deleted ${previousKey.name} (${previousKey.accessKeyId}).`);
  return true;
}

// ── Management API ──────────────────────────────────────────────

async function listAccessKeys(ctx: RegionContext, tenantId: string): Promise<AccessKey[]> {
  const { data, error } = await getTenantsByTenantIdAccessKeys({
    client: ctx.client,
    path: { tenantId },
    throwOnError: false,
  });
  if (error) throw new Error(`could not list access keys — ${formatError(error)}`);
  return data?.items ?? [];
}

/** Undefined only on a 404. Every other failure throws. */
async function getAccessKey(
  ctx: RegionContext,
  tenantId: string,
  accessKeyId: string,
): Promise<AccessKey | undefined> {
  const { data, error, response } = await getTenantsByTenantIdAccessKeysByAccessKeyId({
    client: ctx.client,
    path: { tenantId, accessKeyId },
    throwOnError: false,
  });
  if (response?.status === 404) return undefined;
  if (error || !data) {
    throw new Error(`could not read access key ${accessKeyId} — ${formatError(error)}`);
  }
  return data;
}

async function deleteAccessKey(
  ctx: RegionContext,
  tenantId: string,
  accessKeyId: string,
): Promise<void> {
  const { error } = await deleteTenantsByTenantIdAccessKeysByAccessKeyId({
    client: ctx.client,
    path: { tenantId, accessKeyId },
    throwOnError: false,
  });
  if (error) throw new Error(`could not delete access key ${accessKeyId} — ${formatError(error)}`);
}

// The loop's catch prefixes region, org and tenant, so this only has to say
// what failed and what the operator does about it.
async function createConsoleKey(
  ctx: RegionContext,
  tenantId: string,
  name: string,
): Promise<CreatedAccessKey> {
  const { data, error, response } = await postTenantsByTenantIdAccessKeys({
    client: ctx.client,
    path: { tenantId },
    body: {
      name,
      permissions: [...CONSOLE_KEY_PERMISSIONS],
      buckets: [],
      expiresAt: null,
    },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(
      `could not create ${name} (HTTP ${response?.status ?? 'none'}) — ` +
        `${formatError(error)}. SSM was not written.`,
    );
  }
  return data;
}

/**
 * Throws unless the key the API says it created is real and can sign: the id
 * has to answer a GET and the credentials have to sign S3 requests before the
 * console is pointed at them.
 */
async function verifyNewKey(
  ctx: RegionContext,
  tenantId: string,
  name: string,
  created: CreatedAccessKey,
): Promise<void> {
  if (!created.accessKeyId || !created.secretAccessKey) {
    throw new Error('the API returned no credentials for the new key; SSM was not written.');
  }
  if (!(await getAccessKey(ctx, tenantId, created.accessKeyId))) {
    throw new Error(
      `the API created ${name} (${created.accessKeyId}) and then 404s on it. ` +
        'SSM was not written; the tenant keeps signing with the key it has.',
    );
  }
  await verifyS3Access(ctx, name, created);
}

// ── S3 data plane ───────────────────────────────────────────────

/**
 * Signs a ListBuckets with the new credentials, then a GetBucketVersioning and
 * a GetBucketCors on the first bucket when there is one: actions the gateway
 * authorizes on their own (fil-forge/hilt#102, #107), which proves it honours
 * the key's grant list. The CORS read is authorized before the gateway looks
 * for a document, so a bucket without one answers NoSuchCORSConfiguration
 * past the check, and that counts as a pass.
 */
async function verifyS3Access(
  ctx: RegionContext,
  name: string,
  key: CreatedAccessKey,
): Promise<void> {
  const s3 = new S3Client({
    region: ctx.region,
    endpoint: ctx.s3EndpointUrl,
    forcePathStyle: true,
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey },
  });

  // A fresh key takes a moment to propagate to the gateway.
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      const { Buckets } = await s3.send(new ListBucketsCommand({}));
      const bucket = Buckets?.[0]?.Name;
      if (bucket) {
        await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        await s3.send(new GetBucketCorsCommand({ Bucket: bucket })).catch((err: unknown) => {
          if (!(err instanceof Error && err.name === 'NoSuchCORSConfiguration')) throw err;
        });
      }
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(
          `${name} (${key.accessKeyId}) failed S3 verification after ${attempts} ` +
            `attempts — ${formatError(err)}. SSM was not written.`,
        );
      }
      await sleep(2000);
    }
  }
}

// ── AWS lookups ─────────────────────────────────────────────────

async function findTenants(
  ctx: RegionContext,
): Promise<Array<{ orgId: string; tenantId: string }>> {
  const tenantIdAttribute = `${ctx.orchestratorId}TenantId`;

  if (orgFilter) {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: `ORG#${orgFilter}` }, sk: { S: 'PROFILE' } },
        ConsistentRead: true,
      }),
    );
    const tenantId = Item?.[tenantIdAttribute]?.S;
    if (!tenantId) {
      console.error(`${ctx.region}: org ${orgFilter} has no ${tenantIdAttribute} — skipping.`);
      return [];
    }
    orgFoundInSomeRegion = true;
    return [{ orgId: orgFilter, tenantId }];
  }

  const tenants: Array<{ orgId: string; tenantId: string }> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'sk = :profile AND attribute_exists(#tenantId)',
        ExpressionAttributeNames: { '#tenantId': tenantIdAttribute },
        ExpressionAttributeValues: { ':profile': { S: 'PROFILE' } },
        ProjectionExpression: 'pk, #tenantId',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const orgId = item.pk?.S?.replace(/^ORG#/, '');
      const tenantId = item[tenantIdAttribute]?.S;
      if (orgId && tenantId) tenants.push({ orgId, tenantId });
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return tenants;
}

/**
 * The accessKeyIds of the org's customer-issued keys, from our own DynamoDB
 * rows (`ORG#<orgId>` / `ACCESSKEY#<id>`, written by the create-access-key
 * handler). The console key was never among them.
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
async function readSsmAccessKeyId(
  ctx: RegionContext,
  tenantId: string,
): Promise<string | undefined> {
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: getSsmParameterName(ctx, tenantId), WithDecryption: true }),
    );
    if (!Parameter?.Value) return undefined;
    return (JSON.parse(Parameter.Value) as { accessKeyId?: string }).accessKeyId;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

// Must match the path getConsoleS3Credentials (lib/s3-credentials.ts) reads.
function getSsmParameterName(ctx: RegionContext, tenantId: string): string {
  return `/filone/${stage}/${ctx.orchestratorId}-s3/access-key/${tenantId}`;
}

// ── Helpers ─────────────────────────────────────────────────────

/** The CONSOLE_KEY_PERMISSIONS actions the key lacks; all of them for a principal key. */
function getMissingPermissions(key: AccessKey): string[] {
  const held: readonly string[] = key.type === 'service' ? key.permissions : [];
  return CONSOLE_KEY_PERMISSIONS.filter((action) => !held.includes(action));
}

function formatLabel(ctx: RegionContext, orgId: string, tenantId: string): string {
  return `${ctx.region} org ${orgId} (tenant ${tenantId})`;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) exitWithUsage(`Missing value for --${name}.`);
  return value;
}

// API error bodies come back as parsed JSON, not Error instances.
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) return JSON.stringify(err);
  return String(err);
}

function exitWithUsage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}
