#!/usr/bin/env node

// Usage: ./bin/reset-region-provisioning.ts --region <region> [--stage <stage>] [--dry-run]
//
// Un-provisions one region for every org in a stage, so the next console
// request re-runs tenant setup from scratch. Use it after the upstream
// orchestrator behind a region has been wiped or re-deployed (e.g. the Forge
// staging environment behind eu-central-3), which leaves every org holding a
// dangling pointer to a tenant that no longer exists.
//
// Provisioning state for a region is a single flat attribute on the org's
// `ORG#{orgId}` / `PROFILE` row in UserInfoTable: an org is provisioned in a
// region iff `{orchestratorId}TenantId` exists (setup writes it last). For each
// org holding that attribute this script deletes the region's ACCESSKEY# rows,
// deletes the region's console credentials from SSM, and finally removes the
// tenant-id attribute — the exact inverse of setup, so an interrupted run stays
// resumable instead of orphaning secrets. For eu-west-1 it also rewinds
// `auroraSetupStatus` to FILONE_ORG_CREATED and drops `auroraSetupFailureCount`,
// because Aurora's setup state machine throws on any other status.
//
// It deliberately does NOT call the orchestrators: upstream tenants and access
// keys are left in place. It also leaves RagIndexerTable rows alone.
//
// Refuses to run against production.
//
// There is no DynamoDB PITR/backup, so the per-org log is the only audit
// trail — capture stdout, e.g. `| tee reset-region.log`.
//
// Target your personal dev stack (stage defaults to $USER):
//   ./bin/reset-region-provisioning.ts --region eu-central-3 --dry-run
//   ./bin/reset-region-provisioning.ts --region eu-central-3
//
// Target staging (AWS account 654654381893):
//   ./bin/reset-region-provisioning.ts --stage staging --region eu-central-3 --dry-run
//   ./bin/reset-region-provisioning.ts --stage staging --region eu-central-3
//
// Confirm the stage and region printed at startup before running without --dry-run.

import { execFileSync } from 'node:child_process';

// Inlined from packages/backend/src/lib/service-orchestrator-registry.ts and
// packages/shared/src/constants.ts — this script must NOT import from
// @filone/shared. Keep in sync when a region is added or re-homed.
const ORCHESTRATOR_ID_BY_REGION: Record<string, string> = {
  'eu-west-1': 'aurora',
  'us-east-1': 'fth',
  'eu-central-3': 'forge',
  'us-east-9': 'forgeDev',
};

// The region an ACCESSKEY# row belongs to when it predates the `region`
// attribute — same default as create-access-key.ts.
const DEFAULT_ACCESS_KEY_REGION = 'eu-west-1';

// Inlined from packages/backend/src/lib/org-setup-status.ts.
const FILONE_ORG_CREATED = 'FILONE_ORG_CREATED';

const PROTECTED_STAGES = ['production'];

function usage(message: string): never {
  console.error(message);
  console.error(
    'Usage: ./bin/reset-region-provisioning.ts --region <region> [--stage <stage>] [--dry-run]',
  );
  console.error(`Regions: ${Object.keys(ORCHESTRATOR_ID_BY_REGION).join(', ')}`);
  process.exit(1);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) usage(`Missing value for --${name}.`);
  return value;
}

const dryRun = process.argv.includes('--dry-run');
const region = readFlag('region') ?? usage('Missing required --region.');
const stage = readFlag('stage') ?? process.env.USER ?? usage('Missing --stage and $USER is unset.');

const orchestratorId = ORCHESTRATOR_ID_BY_REGION[region];
if (!orchestratorId) usage(`Unknown region "${region}".`);

if (PROTECTED_STAGES.includes(stage)) {
  console.error(`Refusing to modify data in the "${stage}" stage.`);
  process.exit(1);
}

// Re-exec under `sst shell` if SST resources aren't available. The `--` keeps
// `sst shell` from parsing our own flags as its own. `pnpm exec` (not `pnpx`)
// runs the workspace's own sst instead of downloading a fresh copy.
if (!process.env.SST_RESOURCE_App) {
  execFileSync(
    'pnpm',
    [
      'exec',
      'sst',
      'shell',
      '--stage',
      stage,
      '--',
      'node',
      import.meta.filename,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(0);
}

import { Resource } from 'sst';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

const tableName = Resource.UserInfoTable.name;

// `sst shell --stage X` leaves .sst/stage untouched, so the stage we were asked
// for and the resources we actually resolved can disagree. SST default-names
// the table `filone-<stage>-UserInfoTableTable`; assert the match rather than
// trusting the flag.
if (!tableName.includes(`filone-${stage}-`)) {
  console.error(`Stage mismatch: --stage "${stage}" but resolved table "${tableName}".`);
  process.exit(1);
}

// Mirrors the region logic in sst.config.ts app() — don't trust ambient
// AWS_REGION for staging/production, whose home region is fixed.
const awsRegion =
  stage === 'staging' || stage === 'production'
    ? 'us-east-2'
    : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');

const dynamo = new DynamoDBClient({ region: awsRegion });
const ssm = new SSMClient({ region: awsRegion });

const tenantIdAttribute = `${orchestratorId}TenantId`;

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Un-provisioning region ${region} (orchestrator "${orchestratorId}", attribute ${tenantIdAttribute})`,
);
console.log(`  stage=${stage} table=${tableName} awsRegion=${awsRegion}`);
console.log('');

interface OrgRows {
  profile?: Record<string, AttributeValue>;
  accessKeys: Array<Record<string, AttributeValue>>;
}

const orgs = await scanOrgRows();

let cleared = 0;
let notProvisioned = 0;
let accessKeysDeleted = 0;
let ssmParametersDeleted = 0;

for (const [orgPk, { profile, accessKeys }] of orgs) {
  if (!profile) continue;

  const tenantId = profile[tenantIdAttribute]?.S;
  if (!tenantId) {
    notProvisioned++;
    continue;
  }

  const regionAccessKeys = accessKeys.filter(
    (item) => (item.region?.S ?? DEFAULT_ACCESS_KEY_REGION) === region,
  );
  const parameterNames = ssmParameterNames(tenantId);

  console.log(
    `  ${dryRun ? '[dry-run] ' : ''}${orgPk} tenantId=${tenantId} keys=${regionAccessKeys.length} ssm=${parameterNames.length}`,
  );

  if (dryRun) {
    cleared++;
    accessKeysDeleted += regionAccessKeys.length;
    ssmParametersDeleted += parameterNames.length;
    continue;
  }

  accessKeysDeleted += await deleteAccessKeyRows(regionAccessKeys);
  ssmParametersDeleted += await deleteSsmParameters(parameterNames);

  // Written last: the tenant-id attribute is what derives the SSM paths above,
  // so clearing it first would orphan them if this run died mid-way.
  const removed = await clearTenantLink(profile);
  if (removed) cleared++;
}

console.log('');
console.log(`Orgs scanned: ${orgs.size}`);
console.log(`${dryRun ? 'Would clear' : 'Cleared'}: ${cleared}`);
console.log(`Not provisioned in ${region}: ${notProvisioned}`);
console.log(`Access-key rows ${dryRun ? 'to delete' : 'deleted'}: ${accessKeysDeleted}`);
console.log(`SSM parameters ${dryRun ? 'to delete' : 'deleted'}: ${ssmParametersDeleted}`);
console.log('Done.');

// Collects every ORG# item in one pass, bucketed by partition key, so each org
// is processed with its access keys already in hand.
async function scanOrgRows(): Promise<Map<string, OrgRows>> {
  const result = new Map<string, OrgRows>();
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const scan = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :orgPrefix)',
        ExpressionAttributeValues: { ':orgPrefix': { S: 'ORG#' } },
        ExclusiveStartKey: lastKey,
      }),
    );
    lastKey = scan.LastEvaluatedKey;

    for (const item of scan.Items ?? []) {
      const pk = item.pk?.S;
      const sk = item.sk?.S;
      if (!pk || !sk) continue;

      let rows = result.get(pk);
      if (!rows) {
        rows = { accessKeys: [] };
        result.set(pk, rows);
      }

      if (sk === 'PROFILE') {
        rows.profile = item;
      } else if (sk.startsWith('ACCESSKEY#')) {
        rows.accessKeys.push(item);
      }
    }
  } while (lastKey);

  return result;
}

// The console credentials tenant setup stashes for this region. Paths are
// uniform across orchestrators (see packages/backend/src/lib/s3-credentials.ts);
// Aurora additionally holds a portal API key.
function ssmParameterNames(tenantId: string): string[] {
  const names = [`/filone/${stage}/${orchestratorId}-s3/access-key/${tenantId}`];
  if (orchestratorId === 'aurora') {
    names.push(`/filone/${stage}/aurora-portal/tenant-api-key/${tenantId}`);
  }
  return names;
}

async function deleteAccessKeyRows(items: Array<Record<string, AttributeValue>>): Promise<number> {
  let deleted = 0;

  // BatchWriteItem supports max 25 items per call
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    await dynamo.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: batch.map((item) => ({
            DeleteRequest: { Key: { pk: item.pk!, sk: item.sk! } },
          })),
        },
      }),
    );
    deleted += batch.length;
  }

  return deleted;
}

// Parameters already gone come back in InvalidParameters rather than throwing,
// which is what makes a re-run safe.
async function deleteSsmParameters(names: string[]): Promise<number> {
  let deleted = 0;

  // DeleteParameters supports max 10 names per call
  for (let i = 0; i < names.length; i += 10) {
    const { DeletedParameters } = await ssm.send(
      new DeleteParametersCommand({ Names: names.slice(i, i + 10) }),
    );
    deleted += DeletedParameters?.length ?? 0;
  }

  return deleted;
}

// Aurora's setup state machine throws on an unexpected auroraSetupStatus and
// advanceStatus() conditions on FILONE_ORG_CREATED, so dropping auroraTenantId
// without rewinding the status would wedge the org. auroraSetupFailureCount
// must go too — at >= 3 it drives the stuck-tenant metric.
async function clearTenantLink(profile: Record<string, AttributeValue>): Promise<boolean> {
  const setClauses = ['updatedAt = :now'];
  const removeClauses = ['#tenantIdAttr'];
  const values: Record<string, AttributeValue> = { ':now': { S: new Date().toISOString() } };

  if (orchestratorId === 'aurora') {
    setClauses.push('auroraSetupStatus = :initialStatus');
    removeClauses.push('auroraSetupFailureCount');
    values[':initialStatus'] = { S: FILONE_ORG_CREATED };
  }

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: profile.pk!, sk: profile.sk! },
        UpdateExpression: `SET ${setClauses.join(', ')} REMOVE ${removeClauses.join(', ')}`,
        // Never upsert a phantom org row.
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: { '#tenantIdAttr': tenantIdAttribute },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn(`  Skipped ${profile.pk?.S}: PROFILE row disappeared mid-run`);
      return false;
    }
    throw err;
  }
}
