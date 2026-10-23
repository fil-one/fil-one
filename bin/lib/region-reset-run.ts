// The AWS side of a region reset: scan, back up, confirm, apply, summarize.
//
// bin/reset-region-provisioning.ts runs it alone. bin/reset-forge-network.ts
// runs it with a `beforeAccount` step that deletes the account's Forge tenant
// first; an account whose step throws keeps all of its FilOne state, so a
// re-run picks it up again. The pure planning lives in region-reset.ts.

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteIndexCommand,
  GetVectorBucketCommand,
  type S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { DeleteParametersCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { AccessKeyKeys, RAGKeys } from '@filone/backend/src/lib/dynamo-records.ts';
import { OrgSetupStatus } from '@filone/backend/src/lib/org-setup-status.ts';
import { scanAll } from './dynamo.ts';
import {
  buildResetPlan,
  formatResetPlan,
  type AccountPlan,
  type OrgRows,
  type RagBucketPlan,
  type ResetPlan,
  type StoredRow,
} from './region-reset.ts';

/** Attempts for a batch write DynamoDB keeps handing back as unprocessed. */
const MAX_BATCH_WRITE_ATTEMPTS = 4;

/** First backoff between those attempts; doubled each time. */
const RETRY_BASE_MS = 200;

export interface RegionResetContext {
  stage: string;
  region: string;
  orchestratorId: string;
  awsRegion: string;
  tables: { userInfo: string; ragIndexer: string };
  vectorBucket: string;
  dynamo: DynamoDBClient;
  ssm: SSMClient;
  s3vectors: S3VectorsClient;
}

export interface RegionResetOptions {
  backupPath: string;
  dryRun: boolean;
  skipPrompt: boolean;
  /** The question the operator answers with `yes`. */
  confirmQuestion: string;
  /** Extra top-level fields for the backup file. */
  backupFields?: Record<string, string>;
  /**
   * Runs before an account's FilOne state is reset. A throw skips the account,
   * leaving its state in place, and records the failure.
   */
  beforeAccount?: (account: AccountPlan) => Promise<void>;
  /** Lines appended to the summary, after the FilOne counts. */
  summarize?: () => string[];
}

export interface AccountFailure {
  orgPk: string;
  message: string;
}

/**
 * Plan, back up, confirm and apply one region's reset. Returns the accounts
 * that were skipped because `beforeAccount` failed; the caller sets the exit
 * code from them.
 */
export async function runRegionReset(
  ctx: RegionResetContext,
  options: RegionResetOptions,
): Promise<AccountFailure[]> {
  // Read the vector bucket before the plan prints: a name that has drifted from
  // sst.config.ts must stop the run here, not halfway through the deletes, where
  // DeleteIndex would report every missing index as already gone.
  await requireVectorBucket(ctx);

  const plan = buildResetPlan({
    stage: ctx.stage,
    region: ctx.region,
    orchestratorId: ctx.orchestratorId,
    vectorBucket: ctx.vectorBucket,
    orgRows: await scanOrgRows(ctx),
    ragRows: await scanRagRows(ctx),
  });

  if (plan.accounts.length === 0) {
    console.log(
      `Nothing to reset: ${plan.notProvisioned} account(s), none provisioned in ${ctx.region}.`,
    );
    return [];
  }

  writeBackup(ctx, plan, options);

  for (const line of formatResetPlan(plan)) console.log(line);
  console.log('');
  console.log(`Backup written to ${options.backupPath}`);

  if (options.dryRun) {
    console.log('Dry run — nothing was deleted.');
    return [];
  }

  if (!options.skipPrompt) await confirm(options.confirmQuestion);

  const result = await applyResetPlan(ctx, plan, options.beforeAccount);

  console.log('');
  console.log(`Accounts cleared: ${result.clearedAccounts}`);
  console.log(`Not provisioned in ${ctx.region}: ${plan.notProvisioned}`);
  console.log(`Access-key rows deleted: ${result.accessKeysDeleted}`);
  console.log(`RAG rows deleted: ${result.ragRowsDeleted}`);
  console.log(`S3 Vectors indexes dropped: ${result.indexesDropped}`);
  console.log(`SSM parameters deleted: ${result.ssmParametersDeleted}`);
  for (const line of options.summarize?.() ?? []) console.log(line);
  console.log(`Backup: ${options.backupPath}`);
  if (result.failures.length > 0) {
    console.log(`Skipped, state kept (re-run to retry): ${result.failures.length}`);
    for (const { orgPk, message } of result.failures) console.log(`  ${orgPk}: ${message}`);
  }
  console.log('Done.');

  return result.failures;
}

export interface ApplyResult {
  clearedAccounts: number;
  accessKeysDeleted: number;
  ssmParametersDeleted: number;
  ragRowsDeleted: number;
  indexesDropped: number;
  failures: AccountFailure[];
}

/** Reset every account in the plan, in the order that keeps a re-run safe. */
export async function applyResetPlan(
  ctx: RegionResetContext,
  plan: ResetPlan,
  beforeAccount?: (account: AccountPlan) => Promise<void>,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    clearedAccounts: 0,
    accessKeysDeleted: 0,
    ssmParametersDeleted: 0,
    ragRowsDeleted: 0,
    indexesDropped: 0,
    failures: [],
  };

  for (const account of plan.accounts) {
    console.log(`  ${account.orgPk}`);

    const failure = beforeAccount && (await runBeforeAccount(beforeAccount, account));
    if (failure) {
      result.failures.push(failure);
      continue;
    }

    for (const bucket of account.ragBuckets) {
      // The index goes before its rows, because the rows are the only record of
      // which index exists: the reverse order would strand an index nothing can
      // name. That is the opposite of purgeRagBucket in deletion-scrub.ts, which
      // can afford it because the deletion record survives to drive a retry.
      result.indexesDropped += await dropRagIndex(ctx, account.orgId, bucket);
      result.ragRowsDeleted += await deleteRows(ctx, ctx.tables.ragIndexer, bucket.rows);
    }

    result.accessKeysDeleted += await deleteRows(ctx, ctx.tables.userInfo, account.accessKeys);
    result.ssmParametersDeleted += await deleteSsmParameters(ctx, account.ssmParameterNames);

    if (account.tenantId) {
      // Written last: the tenant-id attribute is what derives the SSM paths
      // above, so clearing it first would orphan them if this run died mid-way.
      if (await clearTenantLink(ctx, account)) result.clearedAccounts++;
    }
  }

  return result;
}

/** The failure to record when the step throws, or undefined when it succeeds. */
async function runBeforeAccount(
  beforeAccount: (account: AccountPlan) => Promise<void>,
  account: AccountPlan,
): Promise<AccountFailure | undefined> {
  try {
    await beforeAccount(account);
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`      skipped, state kept: ${message}`);
    return { orgPk: account.orgPk, message };
  }
}

/**
 * The vector bucket the RAG indexes live in, read so the run stops on a name
 * that no longer exists.
 */
async function requireVectorBucket(ctx: RegionResetContext): Promise<void> {
  try {
    await ctx.s3vectors.send(new GetVectorBucketCommand({ vectorBucketName: ctx.vectorBucket }));
  } catch (err) {
    console.error(
      `Could not read vector bucket "${ctx.vectorBucket}" in ${ctx.awsRegion}: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "Check the RagVectorBucket name in sst.config.ts and the profile's s3vectors permissions.",
    );
    process.exit(1);
  }
}

/**
 * Every ORG# row in one pass, bucketed by partition key, so each account is
 * planned with its access keys already in hand.
 *
 * Both inventory scans read consistently: a row written moments before the
 * run must be in the plan, or the reset deletes around it and reports success.
 */
async function scanOrgRows(ctx: RegionResetContext): Promise<Map<string, OrgRows>> {
  const result = new Map<string, OrgRows>();

  for await (const item of scanAll(ctx.dynamo, {
    TableName: ctx.tables.userInfo,
    ConsistentRead: true,
    FilterExpression: 'begins_with(pk, :orgPrefix)',
    ExpressionAttributeValues: { ':orgPrefix': { S: AccessKeyKeys.orgPk('') } },
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
    else if (sk.startsWith(AccessKeyKeys.keySkPrefix())) rows.accessKeys.push(item);
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
async function scanRagRows(ctx: RegionResetContext): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];

  for await (const item of scanAll(ctx.dynamo, {
    TableName: ctx.tables.ragIndexer,
    ConsistentRead: true,
    FilterExpression: 'begins_with(pk, :bucketPrefix) OR begins_with(pk, :checkpointPrefix)',
    ExpressionAttributeValues: {
      ':bucketPrefix': { S: RAGKeys.bucketPkPrefix() },
      ':checkpointPrefix': { S: RAGKeys.checkpointPkPrefix() },
    },
  })) {
    rows.push(item);
  }

  return rows;
}

/**
 * The plan as a file, written before anything is deleted.
 *
 * It carries the full stored rows rather than a summary, because that is what
 * a future restore would read. `wx` refuses an existing file, so a second run
 * with the same `--backup` path stops instead of overwriting the record of the
 * first.
 */
function writeBackup(
  ctx: RegionResetContext,
  resetPlan: ResetPlan,
  options: RegionResetOptions,
): void {
  const backup = {
    stage: ctx.stage,
    region: ctx.region,
    ...options.backupFields,
    orchestratorId: ctx.orchestratorId,
    tenantIdAttribute: `${ctx.orchestratorId}TenantId`,
    awsRegion: ctx.awsRegion,
    generatedAt: new Date().toISOString(),
    tables: { userInfo: ctx.tables.userInfo, ragIndexer: ctx.tables.ragIndexer },
    vectorBucket: ctx.vectorBucket,
    accounts: resetPlan.accounts,
  };

  try {
    writeFileSync(options.backupPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    console.error(
      `Could not write the backup to ${options.backupPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

/** The literal `yes` on stdin, or the run stops having deleted nothing. */
async function confirm(question: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('');
    console.error('stdin is not a TTY, so there is nobody to confirm the plan.');
    console.error('Re-run with --yes to apply it, or --dry-run to print it.');
    process.exit(1);
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await readline.question(`${question} Type yes: `);
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
 * and its rows — safe. The same rule as `S3VectorsStore.dropIndex` in
 * packages/rag-shared/src/s3-vectors-store.ts; this copy prints the outcome per
 * bucket and counts it, which the store does not.
 */
async function dropRagIndex(
  ctx: RegionResetContext,
  orgId: string,
  bucket: RagBucketPlan,
): Promise<number> {
  try {
    await ctx.s3vectors.send(
      new DeleteIndexCommand({ vectorBucketName: ctx.vectorBucket, indexName: bucket.indexName }),
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
async function deleteRows(
  ctx: RegionResetContext,
  tableName: string,
  items: readonly StoredRow[],
): Promise<number> {
  let deleted = 0;

  // BatchWriteItem supports max 25 items per call.
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk!, sk: item.sk! } },
    }));

    for (let attempt = 1; pending.length > 0; attempt++) {
      const { UnprocessedItems } = await ctx.dynamo.send(
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
async function deleteSsmParameters(
  ctx: RegionResetContext,
  names: readonly string[],
): Promise<number> {
  let deleted = 0;

  // DeleteParameters supports max 10 names per call.
  for (let i = 0; i < names.length; i += 10) {
    const { DeletedParameters } = await ctx.ssm.send(
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
async function clearTenantLink(ctx: RegionResetContext, account: AccountPlan): Promise<boolean> {
  const setClauses = ['updatedAt = :now'];
  const removeClauses = ['#tenantIdAttr'];
  const values: Record<string, AttributeValue> = { ':now': { S: new Date().toISOString() } };

  if (ctx.orchestratorId === 'aurora') {
    setClauses.push('auroraSetupStatus = :initialStatus');
    removeClauses.push('auroraSetupFailureCount');
    values[':initialStatus'] = { S: OrgSetupStatus.FILONE_ORG_CREATED };
  }

  try {
    await ctx.dynamo.send(
      new UpdateItemCommand({
        TableName: ctx.tables.userInfo,
        Key: { pk: { S: account.orgPk }, sk: { S: 'PROFILE' } },
        UpdateExpression: `SET ${setClauses.join(', ')} REMOVE ${removeClauses.join(', ')}`,
        // Never upsert a phantom account row.
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: { '#tenantIdAttr': `${ctx.orchestratorId}TenantId` },
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
