#!/usr/bin/env node

// Re-issue the per-tenant Forge console access key so it carries the bucket
// versioning and object-lock actions.
//
// The console talks to each Forge region's S3 gateway with one service key per
// tenant, created during tenant setup and stashed at
// /filone/<stage>/<orchestratorId>-s3/access-key/<tenantId> — see
// packages/backend/src/lib/orchestrator/tenant-setup.ts. Since fil-forge/hilt#102
// the gateway authorizes GET/PUT ?versioning and ?object-lock on their own
// actions, and keys minted before CONSOLE_KEY_PERMISSIONS gained them get a 403
// on every bucket page. The Management API cannot update a key and key names
// are unique within a tenant, so the key cannot be replaced in place. `rotate`
// creates a second key named `filone-console-v2` and points SSM at it; `prune`
// deletes the old `filone-console` key afterwards.
//
// Usage:
//   node bin/forge-console-key.ts rotate <stage> [--region <region>] [--org <orgId>] [--dry-run]
//   node bin/forge-console-key.ts prune  <stage> [--region <region>] [--org <orgId>] [--dry-run]
//
//   node bin/forge-console-key.ts rotate staging --dry-run
//   node bin/forge-console-key.ts rotate staging
//   node bin/forge-console-key.ts prune  staging
//
// Every Forge region the stage offers is processed (getAvailableRegions in
// @filone/shared, filtered to the regions FORGE_NETWORKS below knows), and
// `--region` narrows the run to one of them. A stage with no Forge region,
// production today, is refused before any AWS call.
//
// Run `rotate` after the backend change is deployed, and `prune` only once
// every container that started before the rotation is gone. Lambda containers
// cache the SSM value for their whole lifetime (getConsoleS3Credentials in
// packages/backend/src/lib/s3-credentials.ts has no TTL), so a warm container
// keeps signing with the v1 key until it recycles; the next deploy replaces
// them all. Both keys are valid until the prune.
//
// `rotate` skips a tenant whose SSM-referenced key already carries the full
// CONSOLE_KEY_PERMISSIONS list, so re-runs and tenants provisioned after the
// change are cheap. It writes SSM only after the new key answers a GET on its id
// and signs an S3 ListBuckets (plus a GetBucketVersioning when the tenant has a
// bucket). A tenant whose verification fails keeps the key it already has.
//
// The Management API takes no idempotency key on access-key creation (see
// management-openapi.yaml, "Idempotency"): a create it already committed comes
// back as a 409 on the name, so there is nothing to replay.
//
// `prune` deletes v1 only for a tenant whose SSM-referenced key exists and
// carries the full list. A tenant provisioned after the change signs with a v1
// key that already has everything, and keeps it. Any other state means the
// rotation has not landed for that tenant: it keeps its working v1 key, is
// reported, and makes the command exit non-zero.
//
// Environment, one pair per Forge network (the Lambda env names, see forgeEnv in
// sst.config.ts for each stage's URL):
//   eu-central-3  FORGE_MANAGEMENT_API_URL,     FORGE_MANAGEMENT_API_TOKEN
//   us-east-9     FORGE_DEV_MANAGEMENT_API_URL, FORGE_DEV_MANAGEMENT_API_TOKEN
//                 FORGE_DEV_S3_ENDPOINT_URL (optional, a local smelt gateway)
// Only the regions the run covers need theirs. The tokens are the stage's
// ForgeManagementApiToken and ForgeDevManagementApiToken secrets.
//
// Talks to AWS directly using your ambient AWS credentials (no `sst shell`).
// Resource names come from `sst state export`.

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { GetBucketVersioningCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
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
import {
  CONSOLE_KEY_NAME,
  CONSOLE_KEY_PERMISSIONS,
} from '@filone/backend/src/lib/orchestrator/tenant-setup.ts';
import { ORCHESTRATOR_ID_BY_REGION } from '@filone/backend/src/lib/service-orchestrator-ids.ts';
import { getAvailableRegions, getS3Endpoint, S3Region } from '@filone/shared';
import { findTable } from './lib/sst-state.ts';

const USAGE =
  'Usage: node bin/forge-console-key.ts <rotate|prune> <stage> [--region <region>] [--org <orgId>] [--dry-run]';

// The key `rotate` creates. RESERVED_KEY_NAME_PREFIX in @filone/shared keeps
// customers off the whole `filone-console` prefix.
const CONSOLE_KEY_NAME_V2 = `${CONSOLE_KEY_NAME}-v2`;

interface ForgeNetwork {
  apiUrlEnv: string;
  tokenEnv: string;
  tokenSecret: string;
  s3EndpointEnv?: string;
}

// The Forge regions and the network serving each, matching the Forge entries
// of getOrchestratorForRegion (packages/backend/src/lib/service-orchestrator-registry.ts).
const FORGE_NETWORKS: Partial<Record<S3Region, ForgeNetwork>> = {
  [S3Region.EuCentral3]: {
    apiUrlEnv: 'FORGE_MANAGEMENT_API_URL',
    tokenEnv: 'FORGE_MANAGEMENT_API_TOKEN',
    tokenSecret: 'ForgeManagementApiToken',
  },
  [S3Region.UsEast9]: {
    apiUrlEnv: 'FORGE_DEV_MANAGEMENT_API_URL',
    tokenEnv: 'FORGE_DEV_MANAGEMENT_API_TOKEN',
    tokenSecret: 'ForgeDevManagementApiToken',
    s3EndpointEnv: 'FORGE_DEV_S3_ENDPOINT_URL',
  },
};

interface RegionContext {
  region: S3Region;
  orchestratorId: string;
  client: Client;
  s3EndpointUrl: string;
}

const command = process.argv[2];
const stage = process.argv[3];

if (command !== 'rotate' && command !== 'prune') {
  usage(`Unknown command: ${command ?? '(none)'}`);
}
if (!stage || stage.startsWith('--')) usage('Missing <stage>.');

const orgFilter = readFlag('org');
const regionFilter = readFlag('region');
const dryRun = process.argv.includes('--dry-run');

const stageForgeRegions = getAvailableRegions(stage).filter((r) => FORGE_NETWORKS[r]);
if (stageForgeRegions.length === 0) {
  console.error(`Stage "${stage}" offers no Forge region. Nothing was read or written.`);
  process.exit(1);
}
if (regionFilter && !stageForgeRegions.includes(regionFilter as S3Region)) {
  usage(
    `--region ${regionFilter} is not a Forge region on stage "${stage}" ` +
      `(Forge regions there: ${stageForgeRegions.join(', ')}).`,
  );
}
const regions = regionFilter ? [regionFilter as S3Region] : stageForgeRegions;

const missingEnv = regions.flatMap((r) => {
  const network = FORGE_NETWORKS[r]!;
  return [network.apiUrlEnv, network.tokenEnv]
    .filter((name) => !process.env[name])
    .map(
      (name) =>
        `  ${name} (${r}${name === network.tokenEnv ? `, secret ${network.tokenSecret}` : ''})`,
    );
});
if (missingEnv.length > 0) {
  console.error(
    `These must be set for the regions this run covers:\n${missingEnv.join('\n')}\n` +
      "URLs are in forgeEnv in sst.config.ts; read the tokens from the stage's secrets with\n" +
      `  pnpm exec sst secret list --stage ${stage}\n` +
      'or pass --region to cover fewer regions.',
  );
  process.exit(1);
}

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

console.error(`Command: ${command}${dryRun ? ' (dry run)' : ''}`);
console.error(`Stage: ${stage}`);
console.error(`Regions: ${regions.join(', ')}`);

const { tableName, region: awsRegion } = findTable(stage, '::UserInfoTableTable');

// `sst state export --stage X` is the only thing that ties this run to a stage,
// so assert the resolved name matches rather than trusting the flag.
if (!tableName.includes(`filone-${stage}-`)) {
  console.error(`Stage mismatch: --stage "${stage}" but resolved table "${tableName}".`);
  process.exit(1);
}
console.error(`UserInfoTable: ${tableName} (region ${awsRegion})`);

const dynamo = new DynamoDBClient({ region: awsRegion });
const ssm = new SSMClient({ region: awsRegion });

let changed = 0;
let skipped = 0;
let failed = 0;
let orgFoundInSomeRegion = false;

for (const region of regions) {
  const network = FORGE_NETWORKS[region]!;
  const baseUrl = process.env[network.apiUrlEnv]!;
  const token = process.env[network.tokenEnv]!;
  const ctx: RegionContext = {
    region,
    orchestratorId: ORCHESTRATOR_ID_BY_REGION[region],
    // Resolved lazily, so the token is not held in a long-lived config object.
    client: createClient({ baseUrl, auth: () => token }),
    s3EndpointUrl:
      (network.s3EndpointEnv && process.env[network.s3EndpointEnv]) || getS3Endpoint(region, stage),
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
      console.error(`${label(ctx, orgId, tenantId)}: FAILED — ${formatError(err)}`);
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

/** Returns true when a new v2 key was created for this tenant. */
async function rotateTenant(ctx: RegionContext, orgId: string, tenantId: string): Promise<boolean> {
  const where = label(ctx, orgId, tenantId);
  const currentAccessKeyId = await readSsmAccessKeyId(ctx, tenantId);
  const currentKey = currentAccessKeyId
    ? await getAccessKey(ctx, tenantId, currentAccessKeyId)
    : undefined;

  if (currentKey && missingPermissions(currentKey).length === 0) {
    console.error(`${where}: already on a key with the full permission list — skipping.`);
    return false;
  }
  if (currentKey?.name === CONSOLE_KEY_NAME_V2) {
    throw new Error(
      `SSM already points at ${CONSOLE_KEY_NAME_V2} (${currentKey.accessKeyId}), which lacks ` +
        `${missingPermissions(currentKey).join(', ')}. A further rotation needs a new key name.`,
    );
  }

  // A v2 key whose secret is not the one in SSM is unusable: the API returns
  // the secret only on create. It can only come from a crash between the create
  // and the SSM write, so delete it and mint a fresh one.
  const existingKeys = await listAccessKeys(ctx, tenantId);
  const staleV2 = existingKeys.find(
    (k) =>
      k.type === 'service' &&
      k.name === CONSOLE_KEY_NAME_V2 &&
      k.accessKeyId !== currentAccessKeyId,
  );
  if (staleV2) {
    // Our DynamoDB rows tell a customer key from a leftover; deleting a key the
    // customer is using would break their integration.
    const customerKeyIds = await findCustomerAccessKeyIds(orgId);
    if (customerKeyIds.has(staleV2.accessKeyId)) {
      throw new Error(
        `${CONSOLE_KEY_NAME_V2} (${staleV2.accessKeyId}) is a customer key on this tenant, ` +
          'not a leftover from a failed rotation. Nothing was changed.',
      );
    }
    console.error(
      `${where}: ${CONSOLE_KEY_NAME_V2} exists (${staleV2.accessKeyId}) but SSM points elsewhere — ` +
        'its secret is unrecoverable, deleting it.',
    );
    if (!dryRun) await deleteAccessKey(ctx, tenantId, staleV2.accessKeyId);
  }

  if (dryRun) {
    console.error(
      `${where}: [dry-run] would create ${CONSOLE_KEY_NAME_V2}, verify it, and repoint ` +
        `${ssmParameterName(ctx, tenantId)}`,
    );
    return true;
  }

  const created = await createV2Key(ctx, tenantId);
  await verifyNewKey(ctx, tenantId, created);

  await ssm.send(
    new PutParameterCommand({
      Name: ssmParameterName(ctx, tenantId),
      Value: JSON.stringify({
        accessKeyId: created.accessKeyId,
        secretAccessKey: created.secretAccessKey,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  console.error(
    `${where}: created ${CONSOLE_KEY_NAME_V2} (${created.accessKeyId}), verified it against the ` +
      'management API and S3, and repointed SSM. Warm Lambda containers keep using the old key ' +
      'until they recycle.',
  );
  return true;
}

/** Returns true when the v1 key was deleted for this tenant. */
async function pruneTenant(ctx: RegionContext, orgId: string, tenantId: string): Promise<boolean> {
  const where = label(ctx, orgId, tenantId);
  const existingKeys = await listAccessKeys(ctx, tenantId);
  const v1 = existingKeys.find((k) => k.type === 'service' && k.name === CONSOLE_KEY_NAME);
  if (!v1) {
    console.error(`${where}: no ${CONSOLE_KEY_NAME} key — nothing to prune.`);
    return false;
  }

  // v1 is the credential that still works, so it goes only once the one
  // replacing it is real and complete.
  const currentAccessKeyId = await readSsmAccessKeyId(ctx, tenantId);
  if (!currentAccessKeyId) {
    throw new Error(
      `${ssmParameterName(ctx, tenantId)} holds no accessKeyId, so the console has no key. ` +
        'Run `rotate` for this tenant first.',
    );
  }
  const currentKey = await getAccessKey(ctx, tenantId, currentAccessKeyId);
  if (!currentKey) {
    throw new Error(
      `SSM points at ${currentAccessKeyId}, which the API answers with a 404. Run \`rotate\` for this tenant first.`,
    );
  }
  const missing = missingPermissions(currentKey);
  if (missing.length > 0) {
    throw new Error(
      `SSM points at ${currentKey.name} (${currentAccessKeyId}), which lacks ${missing.join(', ')}. ` +
        'Run `rotate` for this tenant first.',
    );
  }
  if (v1.accessKeyId === currentAccessKeyId) {
    console.error(
      `${where}: the console signs with ${CONSOLE_KEY_NAME}, which carries the full list — keeping it.`,
    );
    return false;
  }

  if (dryRun) {
    console.error(`${where}: [dry-run] would delete ${CONSOLE_KEY_NAME} (${v1.accessKeyId})`);
    return true;
  }

  await deleteAccessKey(ctx, tenantId, v1.accessKeyId);
  console.error(`${where}: deleted ${CONSOLE_KEY_NAME} (${v1.accessKeyId}).`);
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
async function createV2Key(ctx: RegionContext, tenantId: string): Promise<CreatedAccessKey> {
  const { data, error, response } = await postTenantsByTenantIdAccessKeys({
    client: ctx.client,
    path: { tenantId },
    body: {
      name: CONSOLE_KEY_NAME_V2,
      permissions: [...CONSOLE_KEY_PERMISSIONS],
      buckets: [],
      expiresAt: null,
    },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(
      `could not create ${CONSOLE_KEY_NAME_V2} (HTTP ${response?.status ?? 'none'}) — ` +
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
  created: CreatedAccessKey,
): Promise<void> {
  if (!created.accessKeyId || !created.secretAccessKey) {
    throw new Error('the API returned no credentials for the new key; SSM was not written.');
  }
  if (!(await getAccessKey(ctx, tenantId, created.accessKeyId))) {
    throw new Error(
      `the API created ${CONSOLE_KEY_NAME_V2} (${created.accessKeyId}) and then 404s on it. ` +
        'SSM was not written; the tenant keeps signing with the key it has.',
    );
  }
  await verifyS3Access(ctx, created);
}

// ── S3 data plane ───────────────────────────────────────────────

/**
 * Signs a ListBuckets with the new credentials, then a GetBucketVersioning on
 * the first bucket when there is one: the action the old key is denied, which
 * proves the gateway honours the new grant.
 */
async function verifyS3Access(ctx: RegionContext, key: CreatedAccessKey): Promise<void> {
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
      if (bucket) await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(
          `${CONSOLE_KEY_NAME_V2} (${key.accessKeyId}) failed S3 verification after ${attempts} ` +
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
      new GetParameterCommand({ Name: ssmParameterName(ctx, tenantId), WithDecryption: true }),
    );
    if (!Parameter?.Value) return undefined;
    return (JSON.parse(Parameter.Value) as { accessKeyId?: string }).accessKeyId;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

// Must match the path getConsoleS3Credentials (lib/s3-credentials.ts) reads.
function ssmParameterName(ctx: RegionContext, tenantId: string): string {
  return `/filone/${stage}/${ctx.orchestratorId}-s3/access-key/${tenantId}`;
}

// ── Helpers ─────────────────────────────────────────────────────

/** The CONSOLE_KEY_PERMISSIONS actions the key lacks; all of them for a principal key. */
function missingPermissions(key: AccessKey): string[] {
  const held: readonly string[] = key.type === 'service' ? key.permissions : [];
  return CONSOLE_KEY_PERMISSIONS.filter((action) => !held.includes(action));
}

function label(ctx: RegionContext, orgId: string, tenantId: string): string {
  return `${ctx.region} org ${orgId} (tenant ${tenantId})`;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) usage(`Missing value for --${name}.`);
  return value;
}

// API error bodies come back as parsed JSON, not Error instances.
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) return JSON.stringify(err);
  return String(err);
}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}
