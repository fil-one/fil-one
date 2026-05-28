// Backfill org PROFILE rows from the legacy `setupStatus` /
// `setupFailureCount` attribute names to the per-orchestrator
// `auroraSetupStatus` / `auroraSetupFailureCount` names introduced by
// FIL-367. Idempotent: re-runs are no-ops because the scan filter excludes
// already-migrated rows and the per-row UpdateItem has a matching condition.
// The legacy attributes are intentionally NOT removed here — the dual-read
// fallback in the application code still depends on them during the
// transition window.
//
// TODO(FIL-382): delete this script.

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

interface BackfillOpts {
  tableName: string;
  dryRun: boolean;
  ddb: DynamoDBClient;
}

export interface BackfillResult {
  scanned: number;
  migrated: number;
  skipped: number;
}

export async function backfillAuroraSetupFields(opts: BackfillOpts): Promise<BackfillResult> {
  const { tableName, dryRun, ddb } = opts;
  const result: BackfillResult = { scanned: 0, migrated: 0, skipped: 0 };

  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          'begins_with(pk, :orgPrefix) AND sk = :profile AND attribute_exists(setupStatus) AND attribute_not_exists(auroraSetupStatus)',
        ExpressionAttributeValues: {
          ':orgPrefix': { S: 'ORG#' },
          ':profile': { S: 'PROFILE' },
        },
        ExclusiveStartKey: lastEvaluatedKey,
        ProjectionExpression: 'pk, sk, setupStatus, setupFailureCount',
      }),
    );

    for (const item of scan.Items ?? []) {
      result.scanned += 1;
      const outcome = await migrateRow({ tableName, dryRun, ddb, item });
      result[outcome] += 1;
    }

    lastEvaluatedKey = scan.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return result;
}

type RowOutcome = 'migrated' | 'skipped';

interface MigrateRowOpts {
  tableName: string;
  dryRun: boolean;
  ddb: DynamoDBClient;
  item: Record<string, AttributeValue>;
}

async function migrateRow(opts: MigrateRowOpts): Promise<RowOutcome> {
  const { tableName, dryRun, ddb, item } = opts;
  const orgId = item.pk?.S?.replace(/^ORG#/, '') ?? '<unknown>';
  const status = item.setupStatus?.S;
  const failureCount = item.setupFailureCount?.N ?? '0';

  if (!status) {
    console.warn('[backfill] skipping row with missing setupStatus', { orgId });
    return 'skipped';
  }

  if (dryRun) {
    console.log('[backfill] (dry-run) would migrate', { orgId, status, failureCount });
    return 'migrated';
  }

  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: item.pk!, sk: item.sk! },
        UpdateExpression:
          'SET auroraSetupStatus = :status, auroraSetupFailureCount = if_not_exists(auroraSetupFailureCount, :count)',
        ConditionExpression: 'attribute_not_exists(auroraSetupStatus)',
        ExpressionAttributeValues: {
          ':status': { S: status },
          ':count': { N: failureCount },
        },
      }),
    );
    console.log('[backfill] migrated', { orgId, status, failureCount });
    return 'migrated';
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Another invocation (or a prior write that landed after the scan)
      // already migrated this row. Safe to skip.
      console.log('[backfill] skipped (already migrated)', { orgId });
      return 'skipped';
    }
    throw err;
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  const tableName = process.env.USER_INFO_TABLE_NAME;
  const stage = process.env.STAGE;
  const dryRun = process.argv.includes('--dry-run');

  if (!tableName || !stage) {
    console.error('Required env vars: STAGE, USER_INFO_TABLE_NAME');
    process.exit(1);
  }

  console.log(`[backfill] starting on stage=${stage} table=${tableName} dryRun=${dryRun}`);
  const ddb = new DynamoDBClient({});
  const result = await backfillAuroraSetupFields({ tableName, dryRun, ddb });
  console.log('[backfill] done', result);
}
