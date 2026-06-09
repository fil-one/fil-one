// One-off cleanup of the legacy `setupStatus` / `setupFailureCount` attributes
// on ORG#... PROFILE rows. FIL-367 renamed these to `auroraSetupStatus` /
// `auroraSetupFailureCount`; the FIL-367 backfill script populated the new
// attributes on every existing row, and `advanceStatus` was REMOVE-ing the
// legacy attribute on every write during the dual-name window. This script
// sweeps any rows that have been silent since FIL-367 deployed and still carry
// the legacy attributes. Idempotent: the scan filter excludes rows already
// cleaned, and the per-row REMOVE is a no-op if the attributes have since
// vanished.
//
// Prerequisites: PR1 (FIL-367) deployed AND the backfill has been verified
// to leave zero rows matching `attribute_exists(setupStatus) AND
// begins_with(pk, "ORG#") AND sk = "PROFILE"`. Without that, removing
// `setupStatus` from a row whose `auroraSetupStatus` is unset would wedge the
// org permanently.

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

interface CleanupOpts {
  tableName: string;
  dryRun: boolean;
  ddb: DynamoDBClient;
}

export interface CleanupResult {
  scanned: number;
  cleaned: number;
  skipped: number;
}

export async function cleanupLegacySetupFields(opts: CleanupOpts): Promise<CleanupResult> {
  const { tableName, dryRun, ddb } = opts;
  const result: CleanupResult = { scanned: 0, cleaned: 0, skipped: 0 };

  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          'begins_with(pk, :orgPrefix) AND sk = :profile AND (attribute_exists(setupStatus) OR attribute_exists(setupFailureCount))',
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
      const outcome = await cleanupRow({ tableName, dryRun, ddb, item });
      result[outcome] += 1;
    }

    lastEvaluatedKey = scan.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return result;
}

type RowOutcome = 'cleaned' | 'skipped';

interface CleanupRowOpts {
  tableName: string;
  dryRun: boolean;
  ddb: DynamoDBClient;
  item: Record<string, AttributeValue>;
}

async function cleanupRow(opts: CleanupRowOpts): Promise<RowOutcome> {
  const { tableName, dryRun, ddb, item } = opts;
  const orgId = item.pk?.S?.replace(/^ORG#/, '') ?? '<unknown>';
  const hasSetupStatus = item.setupStatus !== undefined;
  const hasSetupFailureCount = item.setupFailureCount !== undefined;

  if (!item.pk || !item.sk) {
    console.warn('[cleanup] skipping row with missing pk/sk', { orgId });
    return 'skipped';
  }

  if (dryRun) {
    console.log('[cleanup] (dry-run) would remove legacy attrs', {
      orgId,
      hasSetupStatus,
      hasSetupFailureCount,
    });
    return 'cleaned';
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: 'REMOVE setupStatus, setupFailureCount',
      ConditionExpression: 'attribute_exists(auroraSetupStatus)',
    }),
  );
  console.log('[cleanup] removed legacy attrs', { orgId, hasSetupStatus, hasSetupFailureCount });
  return 'cleaned';
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

  console.log(`[cleanup] starting on stage=${stage} table=${tableName} dryRun=${dryRun}`);
  const ddb = new DynamoDBClient({});
  const result = await cleanupLegacySetupFields({ tableName, dryRun, ddb });
  console.log('[cleanup] done', result);
}
