import { ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { usesRagEngine, type S3Region } from '@filone/shared';
import { getDynamoClient } from './ddb-client.ts';
import { collectPages } from './ddb-paging.ts';
import { RAGKeys } from './dynamo-records.ts';
import { getRagEngineClient, getRagEngineConfig, ragEngineTarget } from './rag-engine-client.ts';
import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';

const LOG = '[rag-engine-teardown]';

/**
 * Account deletion, Forge regions: ask the Bucket Intelligence engine to drop
 * each enabled bucket's Lance dataset and forget its sync state.
 *
 * Runs before the tenants are disabled and deleted, because the engine reaches
 * the dataset with the tenant's own Forge credentials. Best effort: deleting the tenant
 * removes its companion buckets with everything else it owns, so an engine that
 * is down is logged and never blocks the teardown. A stage with no engine
 * (production) returns at once, without reading the table.
 *
 * @param tenantIds the org's tenant id per orchestrator id, as the deletion
 *   targets resolve them.
 */
export async function dropRagEngineDatasets(
  orgId: string,
  tenantIds: Record<string, string>,
): Promise<void> {
  // Production has no engine and no Forge regions: return before the Scan, so
  // account deletion there does no extra work and gains no failure point.
  const config = getRagEngineConfig();
  if (!config) return;
  const client = getRagEngineClient(config);

  let buckets: { region: S3Region; bucketName: string }[];
  try {
    buckets = await engineBuckets(orgId);
  } catch (error) {
    console.warn(`${LOG} could not list the org's buckets, leaving datasets to tenant deletion`, {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  async function drop({ region, bucketName }: { region: S3Region; bucketName: string }) {
    try {
      const orchestrator = getOrchestratorForRegion(region);
      const tenantId = tenantIds[orchestrator.id];
      if (!tenantId) return;
      await client.drop(
        await ragEngineTarget(orchestrator, tenantId, { orgId, region, bucketName }),
      );
    } catch (error) {
      console.warn(`${LOG} engine drop failed, leaving the dataset to tenant deletion`, {
        orgId,
        region,
        bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Each drop can wait out the engine timeout when the engine is down, so the
  // drops run DROP_CONCURRENCY at a time to keep that wait a small part of
  // the deletion worker's budget.
  const queue = [...buckets];
  const runners = Array.from({ length: Math.min(DROP_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await drop(next);
  });
  await Promise.all(runners);
}

/** Engine drops in flight at once during account deletion. */
export const DROP_CONCURRENCY = 8;

/** The org's RAG-enabled buckets (any status) in engine-backed regions. */
async function engineBuckets(orgId: string): Promise<{ region: S3Region; bucketName: string }[]> {
  const rows = await collectPages((cursor) =>
    getDynamoClient().send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'begins_with(pk, :bucket) AND sk = :sk',
        ProjectionExpression: 'pk',
        ExpressionAttributeValues: marshall({
          ':bucket': `BUCKET#${orgId}#`,
          ':sk': RAGKeys.enablementSk(),
        }),
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );
  return rows.flatMap((row) => {
    const parsed = RAGKeys.parseBucketPk(row.pk?.S ?? '');
    return parsed && parsed.orgId === orgId && usesRagEngine(parsed.region)
      ? [{ region: parsed.region, bucketName: parsed.bucketName }]
      : [];
  });
}
