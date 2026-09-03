import { ScanCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from '../src/lib/ddb-client.js';
import { reserveOrgSlug } from '../src/lib/org-slug.js';

/**
 * One-off: give every org profile row a slug, for orgs created before the
 * `slug` field existed.
 *
 * No migration framework exists in this repo — `deletion-scrub.ts` and
 * `stuck-tenant-metric.ts` are the closest precedent for a standalone
 * operational script — so this scans `ORG#{orgId}/PROFILE` rows in
 * UserInfoTable, skips any that already carry a slug, and reserves one for
 * the rest via the same `reserveOrgSlug` the create and rename paths use. Run
 * once per stage before shipping the frontend's slug-scoped routing: a route
 * cannot resolve a slug that does not exist yet.
 *
 * Idempotent by construction — a row already carrying a slug is skipped, and
 * the write is conditioned on the row still lacking one — so re-running it
 * after a partial failure only touches what the first pass missed.
 *
 * Run via `sst shell`, which is what resolves `Resource.UserInfoTable.name`
 * and `Resource.OrgTable.name` against the stage's real tables:
 *
 *   pnpm exec sst shell --stage <stage> -- npx tsx packages/backend/scripts/backfill-org-slugs.ts
 */

export interface BackfillResult {
  /** Org profile rows the scan visited. */
  scanned: number;
  /** Rows that already carried a slug — left untouched. */
  alreadySlugged: number;
  /** Rows a slug was reserved and written for. */
  backfilled: number;
  /** Rows the reservation or the write failed for — re-run to retry these. */
  failed: number;
}

const ORG_PROFILE_PREFIX = 'ORG#';

function isOrgProfileRow(item: Record<string, AttributeValue>): boolean {
  return Boolean(item.pk?.S?.startsWith(ORG_PROFILE_PREFIX)) && item.sk?.S === 'PROFILE';
}

export async function backfillOrgSlugs(): Promise<BackfillResult> {
  const dynamo = getDynamoClient();
  const userInfoTableName = Resource.UserInfoTable.name;
  const orgTableName = Resource.OrgTable.name;

  const result: BackfillResult = { scanned: 0, alreadySlugged: 0, backfilled: 0, failed: 0 };
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await dynamo.send(
      new ScanCommand({
        TableName: userInfoTableName,
        FilterExpression: 'begins_with(pk, :orgPrefix) AND sk = :sk',
        ExpressionAttributeValues: {
          ':orgPrefix': { S: ORG_PROFILE_PREFIX },
          ':sk': { S: 'PROFILE' },
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of Items ?? []) {
      if (!isOrgProfileRow(item)) continue;
      result.scanned++;

      if (item.slug?.S) {
        result.alreadySlugged++;
        continue;
      }

      const orgId = item.pk!.S!.slice(ORG_PROFILE_PREFIX.length);
      const name = item.name?.S ?? '';

      try {
        const { slug, reservationItem } = await reserveOrgSlug({
          orgId,
          name,
          tableName: orgTableName,
        });

        await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  TableName: userInfoTableName,
                  Key: { pk: item.pk!, sk: item.sk! },
                  UpdateExpression: 'SET slug = :slug',
                  // Idempotency: a re-run that raced this exact row between
                  // the read above and this write leaves the winner's slug in
                  // place rather than overwriting it with a second one.
                  ConditionExpression: 'attribute_not_exists(slug)',
                  ExpressionAttributeValues: { ':slug': { S: slug } },
                },
              },
              reservationItem,
            ],
          }),
        );

        result.backfilled++;
        console.log(`[backfill-org-slugs] ${orgId} -> ${slug}`);
      } catch (err) {
        result.failed++;
        console.error(`[backfill-org-slugs] failed for org ${orgId}`, err);
      }
    }

    startKey = LastEvaluatedKey;
  } while (startKey);

  return result;
}

// ── CLI entry point ──────────────────────────────────────────────────────

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  const result = await backfillOrgSlugs();
  console.log('[backfill-org-slugs] done', result);
  if (result.failed > 0) process.exit(1);
}
