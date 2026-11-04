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
import { DeleteParametersCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { AccessKeyKeys } from '@filone/backend/src/lib/dynamo-records.ts';
import { OrgSetupStatus } from '@filone/backend/src/lib/org-setup-status.ts';
import { scanAll } from './dynamo.ts';
import {
  buildResetPlan,
  formatResetPlan,
  type AccountPlan,
  type OrgRows,
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
  tables: { userInfo: string };
  dynamo: DynamoDBClient;
  ssm: SSMClient;
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
  const plan = buildResetPlan({
    stage: ctx.stage,
    region: ctx.region,
    orchestratorId: ctx.orchestratorId,
    orgRows: await scanOrgRows(ctx),
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
    failures: [],
  };

  for (const account of plan.accounts) {
    console.log(`  ${account.orgPk}`);

    const failure = beforeAccount && (await runBeforeAccount(beforeAccount, account));
    if (failure) {
      result.failures.push(failure);
      continue;
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
 * Every ORG# row in one pass, bucketed by partition key, so each account is
 * planned with its access keys already in hand.
 *
 * The scan reads consistently: a row written moments before the run must be in
 * the plan, or the reset deletes around it and reports success.
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
    tables: { userInfo: ctx.tables.userInfo },
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
 * Delete rows by key, retrying the ones DynamoDB hands back.
 *
 * A throttled `BatchWriteItem` returns the keys it did not write in
 * `UnprocessedItems` rather than failing. Counting a batch as deleted without
 * checking would overstate the total and leave rows behind, so the run retries with the same backoff shape as
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
