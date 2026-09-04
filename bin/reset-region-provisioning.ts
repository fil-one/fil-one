#!/usr/bin/env node

// Usage: node bin/reset-region-provisioning.ts --stage <stage> --region <region>
//                [--dry-run] [--yes] [--backup <path>]
//
// Un-provisions one region for every customer account in a stage, so the next
// console request re-runs tenant setup from scratch. Use it after the upstream
// orchestrator behind a region has been wiped or re-deployed (a Forge dev
// network reset), or when a pilot region is retired — either way every account
// keeps a dangling pointer to a tenant that no longer exists.
//
// Provisioning state for a region is a single flat attribute on the account's
// `ORG#{orgId}` / `PROFILE` row in UserInfoTable: an account is provisioned in
// a region iff `{orchestratorId}TenantId` exists, because setup writes it last.
// A personal account is an organization of one, so scanning `ORG#` covers both
// kinds. For each provisioned account the reset drops the region's S3 Vectors
// indexes and RagIndexerTable rows, deletes the region's ACCESSKEY# rows,
// deletes the region's console credentials from SSM, and removes the tenant-id
// attribute last — the inverse of setup, so an interrupted run stays resumable
// instead of orphaning state nothing can name. For eu-west-1 it also rewinds
// `auroraSetupStatus` to FILONE_ORG_CREATED and drops
// `auroraSetupFailureCount`, because Aurora's setup state machine throws on any
// other status.
//
// Which regions each stage allows:
//
//   production      eu-central-3, us-east-9 — the pilot regions
//   every other     all four
//
// Production refuses eu-west-1 (Aurora) and us-east-1 (FTH) by name: they are
// generally available and carry real customer data, so clearing their tenant
// pointers would cut off every production customer at once.
//
// Credentials: no `sst shell` (it cannot evaluate pulumi providers against
// production). Table names come from `sst state export`, and every AWS call
// uses your ambient credentials, so confirm they target the right account
// first. Applying needs a role that can write UserInfoTable and
// RagIndexerTable, delete SSM parameters, and call s3vectors:GetVectorBucket
// and s3vectors:DeleteIndex.
//
// The run scans, prints the plan, and asks for confirmation: type `yes` to
// apply. `--yes` skips the prompt, `--dry-run` prints the plan and exits
// without prompting, and a run carrying both stays a dry run. This is the only
// interactive prompt in bin/, where every other script gates a write behind
// `--execute` alone; a reset takes a whole region away from every account in
// the stage, and the plan naming those accounts is what an operator has to read
// before saying yes. Without a TTY on stdin and without `--yes` the run exits
// rather than consuming a stray line of input.
//
// Every run writes a JSON backup of the state it is about to delete, `--dry-run`
// included, so the account-to-tenant mapping can be restored. A restore
// re-creates the upstream tenant under the recorded tenantId, re-writes the
// profile attributes, and mints fresh access keys from the recorded names,
// permissions, bucket scopes and expiries — minting new keys is the one step it
// cannot avoid, because the backup holds no secret material and the SSM values
// are never read. RAG indexes come back by re-enabling RAG and letting the
// indexer sync; the vectors themselves are not in the backup.
//
// It deliberately does NOT call the orchestrators: upstream tenants, buckets
// and access keys are left in place, because the reset assumes they are already
// gone.
//
// There is no DynamoDB PITR, so the printed plan is the only audit trail —
// capture stdout, e.g. `| tee reset-region.log`.
//
//   node bin/reset-region-provisioning.ts --stage $USER --region eu-central-3 --dry-run
//   node bin/reset-region-provisioning.ts --stage staging --region eu-central-3
//   node bin/reset-region-provisioning.ts --stage production --region us-east-9

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteIndexCommand,
  GetVectorBucketCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { scanAll } from './lib/dynamo.ts';
import {
  assertRegionAllowed,
  buildResetPlan,
  formatResetPlan,
  FILONE_ORG_CREATED,
  ORCHESTRATOR_ID_BY_REGION,
  type AccountPlan,
  type OrgRows,
  type RagBucketPlan,
  type ResetPlan,
  type StoredRow,
} from './lib/region-reset.ts';
import { requireAwsProfile } from './lib/sst-state.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';

const USAGE =
  'Usage: node bin/reset-region-provisioning.ts --stage <stage> --region <region> [--dry-run] [--yes] [--backup <path>]';

/**
 * Every flag this script understands.
 *
 * Enumerated so an unrecognized `--` argument stops the run, the way
 * bin/lib/args.ts and bin/orgs-beta.ts stop on one: a misspelled `--dry-run`
 * that is silently ignored is the worst possible place to be quiet.
 */
const KNOWN_FLAGS = new Set(['--dry-run', '--yes']);
const KNOWN_OPTIONS = new Set(['--stage', '--region', '--backup']);

/** Attempts for a batch write DynamoDB keeps handing back as unprocessed. */
const MAX_BATCH_WRITE_ATTEMPTS = 4;

/** First backoff between those attempts; doubled each time. */
const RETRY_BASE_MS = 200;

const { flags, options } = parseArgs(process.argv.slice(2));

const dryRun = flags.has('--dry-run');
// A run carrying both stays a dry run: the flag that refuses to write wins.
const skipPrompt = flags.has('--yes') && !dryRun;
const stage = options.get('--stage') ?? usage('Missing required --stage.');
const region = options.get('--region') ?? usage('Missing required --region.');

// Before any AWS work: a region this stage will not accept costs a message,
// not a state export against production.
try {
  assertRegionAllowed(stage, region);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const orchestratorId = ORCHESTRATOR_ID_BY_REGION[region]!;
const tenantIdAttribute = `${orchestratorId}TenantId`;

// Keep in sync with the RagVectorBucket name in sst.config.ts.
const vectorBucket = `filone-${stage}-rag-vectors`;

const backupPath =
  options.get('--backup') ??
  `region-backup-${stage}-${region}-${new Date().toISOString().replaceAll(':', '-')}.json`;

requireAwsProfile();

const tables = resolveStageTables(stage, {
  userInfo: '::UserInfoTableTable',
  ragIndexer: '::RagIndexerTableTable',
});
assertStageResources(stage, tables);

const awsRegion = awsRegionForStage(stage);
const dynamo = new DynamoDBClient({ region: awsRegion });
const ssm = new SSMClient({ region: awsRegion });
const s3vectors = new S3VectorsClient({ region: awsRegion });

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Un-provisioning region ${region} (orchestrator "${orchestratorId}", attribute ${tenantIdAttribute})`,
);
console.log(`  stage=${stage} awsRegion=${awsRegion}`);
console.log(`  UserInfoTable=${tables.userInfo} RagIndexerTable=${tables.ragIndexer}`);
console.log(`  vector bucket=${vectorBucket}`);
console.log('');

// Read the vector bucket before the plan prints: a name that has drifted from
// sst.config.ts must stop the run here, not halfway through the deletes, where
// DeleteIndex would report every missing index as already gone.
await requireVectorBucket();

const plan = buildResetPlan({
  stage,
  region,
  orchestratorId,
  vectorBucket,
  orgRows: await scanOrgRows(),
  ragRows: await scanRagRows(),
});

writeBackup(plan);

for (const line of formatResetPlan(plan)) console.log(line);
console.log('');
console.log(`Backup written to ${backupPath}`);

if (plan.accounts.length === 0) {
  console.log('Nothing to reset.');
  process.exit(0);
}

if (dryRun) {
  console.log('Dry run — nothing was deleted.');
  process.exit(0);
}

if (!skipPrompt) await confirm();

let clearedAccounts = 0;
let accessKeysDeleted = 0;
let ssmParametersDeleted = 0;
let ragRowsDeleted = 0;
let indexesDropped = 0;

for (const account of plan.accounts) {
  console.log(`  ${account.orgPk}`);

  for (const bucket of account.ragBuckets) {
    // The index goes before its rows, because the rows are the only record of
    // which index exists: the reverse order would strand an index nothing can
    // name. That is the opposite of purgeRagBucket in deletion-scrub.ts, which
    // can afford it because the deletion record survives to drive a retry.
    indexesDropped += await dropRagIndex(account.orgId, bucket);
    ragRowsDeleted += await deleteRows(tables.ragIndexer, bucket.rows);
  }

  accessKeysDeleted += await deleteRows(tables.userInfo, account.accessKeys);
  ssmParametersDeleted += await deleteSsmParameters(account.ssmParameterNames);

  if (account.tenantId) {
    // Written last: the tenant-id attribute is what derives the SSM paths
    // above, so clearing it first would orphan them if this run died mid-way.
    if (await clearTenantLink(account)) clearedAccounts++;
  }
}

console.log('');
console.log(`Accounts cleared: ${clearedAccounts}`);
console.log(`Not provisioned in ${region}: ${plan.notProvisioned}`);
console.log(`Access-key rows deleted: ${accessKeysDeleted}`);
console.log(`RAG rows deleted: ${ragRowsDeleted}`);
console.log(`S3 Vectors indexes dropped: ${indexesDropped}`);
console.log(`SSM parameters deleted: ${ssmParametersDeleted}`);
console.log(`Backup: ${backupPath}`);
console.log('Done.');

function parseArgs(argv: readonly string[]): {
  flags: Set<string>;
  options: Map<string, string>;
} {
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (KNOWN_FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (!KNOWN_OPTIONS.has(arg)) usage(`Unrecognized argument: ${arg}`);

    const value = argv[++i];
    if (!value || value.startsWith('--')) usage(`Missing value for ${arg}.`);
    options.set(arg, value);
  }

  return { flags, options };
}

function usage(message: string): never {
  console.error(message);
  console.error(USAGE);
  console.error(`Regions: ${Object.keys(ORCHESTRATOR_ID_BY_REGION).join(', ')}`);
  process.exit(1);
}

/**
 * The vector bucket the RAG indexes live in, read so the run stops on a name
 * that no longer exists.
 */
async function requireVectorBucket(): Promise<void> {
  try {
    await s3vectors.send(new GetVectorBucketCommand({ vectorBucketName: vectorBucket }));
  } catch (err) {
    console.error(
      `Could not read vector bucket "${vectorBucket}" in ${awsRegion}: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "Check the RagVectorBucket name in sst.config.ts and the profile's s3vectors permissions.",
    );
    process.exit(1);
  }
}

/**
 * Every ORG# row in one pass, bucketed by partition key, so each account is
 * planned with its access keys already in hand.
 */
async function scanOrgRows(): Promise<Map<string, OrgRows>> {
  const result = new Map<string, OrgRows>();

  for await (const item of scanAll(dynamo, {
    TableName: tables.userInfo,
    FilterExpression: 'begins_with(pk, :orgPrefix)',
    ExpressionAttributeValues: { ':orgPrefix': { S: 'ORG#' } },
  })) {
    const pk = item.pk?.S;
    const sk = item.sk?.S;
    if (!pk || !sk) continue;

    let rows = result.get(pk);
    if (!rows) {
      rows = { accessKeys: [] };
      result.set(pk, rows);
    }

    if (sk === 'PROFILE') rows.profile = item;
    else if (sk.startsWith('ACCESSKEY#')) rows.accessKeys.push(item);
  }

  return result;
}

/**
 * Every RAG row keyed by a bucket or a checkpoint.
 *
 * The region sits in the partition key, so the filter cannot name it; the plan
 * keeps the rows whose key parses to the target region. The org-level
 * `RAGCONFIG` row is keyed `ORG#{orgId}` and stays out of both prefixes.
 */
async function scanRagRows(): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];

  for await (const item of scanAll(dynamo, {
    TableName: tables.ragIndexer,
    FilterExpression: 'begins_with(pk, :bucketPrefix) OR begins_with(pk, :checkpointPrefix)',
    ExpressionAttributeValues: {
      ':bucketPrefix': { S: 'BUCKET#' },
      ':checkpointPrefix': { S: 'INDEXER_CHECKPOINT#' },
    },
  })) {
    rows.push(item);
  }

  return rows;
}

/**
 * The plan as a file, written before anything is deleted.
 *
 * It carries the full stored rows rather than a summary, because it is what a
 * restore reads. `wx` refuses an existing file, so a second run with the same
 * `--backup` path stops instead of overwriting the record of the first.
 */
function writeBackup(resetPlan: ResetPlan): void {
  const backup = {
    stage,
    region,
    orchestratorId,
    tenantIdAttribute,
    awsRegion,
    generatedAt: new Date().toISOString(),
    tables: { userInfo: tables.userInfo, ragIndexer: tables.ragIndexer },
    vectorBucket,
    accounts: resetPlan.accounts,
  };

  try {
    writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    console.error(
      `Could not write the backup to ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

/** The literal `yes` on stdin, or the run stops having deleted nothing. */
async function confirm(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('');
    console.error('stdin is not a TTY, so there is nobody to confirm the plan.');
    console.error('Re-run with --yes to apply it, or --dry-run to print it.');
    process.exit(1);
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await readline.question(`Reset ${region} in stage "${stage}"? Type yes: `);
  readline.close();

  if (answer.trim() !== 'yes') {
    console.log('Aborted — nothing was deleted.');
    process.exit(0);
  }
}

/**
 * Drop one bucket's S3 Vectors index.
 *
 * A missing index comes back as NotFoundException rather than throwing the run
 * over, which is what makes a re-run — or a run interrupted between the index
 * and its rows — safe. Mirrors `S3VectorsStore.dropIndex` in
 * packages/rag-shared/src/s3-vectors-store.ts, which cannot be imported here.
 */
async function dropRagIndex(orgId: string, bucket: RagBucketPlan): Promise<number> {
  try {
    await s3vectors.send(
      new DeleteIndexCommand({ vectorBucketName: vectorBucket, indexName: bucket.indexName }),
    );
    console.log(`      dropped index ${bucket.indexName} (${bucket.bucketName})`);
    return 1;
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') {
      console.warn(`      no index ${bucket.indexName} (${bucket.bucketName}) — already gone`);
      return 0;
    }
    throw err;
  }
}

/**
 * Delete rows by key, retrying the ones DynamoDB hands back.
 *
 * A throttled `BatchWriteItem` returns the keys it did not write in
 * `UnprocessedItems` rather than failing, and a bucket's manifest is one row
 * per indexed object — enough rows to hit that. Counting a batch as deleted
 * without checking would overstate the total and leave rows behind whose index
 * is already gone, so the run retries with the same backoff shape as
 * `transactWithRetry` in bin/lib/dynamo.ts and stops if they keep coming back.
 */
async function deleteRows(tableName: string, items: readonly StoredRow[]): Promise<number> {
  let deleted = 0;

  // BatchWriteItem supports max 25 items per call.
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk!, sk: item.sk! } },
    }));

    for (let attempt = 1; pending.length > 0; attempt++) {
      const { UnprocessedItems } = await dynamo.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: pending } }),
      );
      const unprocessed = UnprocessedItems?.[tableName] ?? [];
      deleted += pending.length - unprocessed.length;

      if (unprocessed.length > 0 && attempt >= MAX_BATCH_WRITE_ATTEMPTS) {
        throw new Error(
          `${unprocessed.length} row(s) in ${tableName} still unprocessed after ${attempt} attempts; ` +
            're-run the same command to finish the deletes',
        );
      }

      pending = unprocessed as typeof pending;
      if (pending.length > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  return deleted;
}

/**
 * Parameters already gone come back in InvalidParameters rather than throwing,
 * which is what makes a re-run safe.
 */
async function deleteSsmParameters(names: readonly string[]): Promise<number> {
  let deleted = 0;

  // DeleteParameters supports max 10 names per call.
  for (let i = 0; i < names.length; i += 10) {
    const { DeletedParameters } = await ssm.send(
      new DeleteParametersCommand({ Names: names.slice(i, i + 10) }),
    );
    deleted += DeletedParameters?.length ?? 0;
  }

  return deleted;
}

/**
 * Remove the tenant-id attribute, and for Aurora rewind the setup state.
 *
 * Aurora's setup state machine throws on an unexpected `auroraSetupStatus` and
 * `advanceStatus()` conditions on FILONE_ORG_CREATED, so dropping
 * `auroraTenantId` without rewinding the status would wedge the account.
 * `auroraSetupFailureCount` must go too — at >= 3 it drives the stuck-tenant
 * metric.
 */
async function clearTenantLink(account: AccountPlan): Promise<boolean> {
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
        TableName: tables.userInfo,
        Key: { pk: { S: account.orgPk }, sk: { S: 'PROFILE' } },
        UpdateExpression: `SET ${setClauses.join(', ')} REMOVE ${removeClauses.join(', ')}`,
        // Never upsert a phantom account row.
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: { '#tenantIdAttr': tenantIdAttribute },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn(`      skipped ${account.orgPk}: PROFILE row disappeared mid-run`);
      return false;
    }
    throw err;
  }
}
