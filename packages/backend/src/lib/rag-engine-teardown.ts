import { ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { usesRagEngine, type S3Region } from '@filone/shared';
import { getDynamoClient } from './ddb-client.ts';
import { collectPages } from './ddb-paging.ts';
import { RAGKeys } from './dynamo-records.ts';
import { getRagEngineClient, ragEngineTarget } from './rag-engine-client.ts';
import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';

const LOG = '[rag-engine-teardown]';

/**
 * Account deletion, Forge regions: ask the Bucket Intelligence engine to drop
 * each enabled bucket's Lance dataset and forget its sync state.
 *
 * Runs before the tenants are deleted, because the engine reaches the dataset
 * with the tenant's own Forge credentials. Best effort: deleting the tenant
 * removes its companion buckets with everything else it owns, so an engine that
 * is down or unconfigured is logged and never blocks the teardown.
 *
 * @param tenantIds the org's tenant id per orchestrator id, as the deletion
 *   targets resolve them.
 */
export async function dropRagEngineDatasets(
  orgId: string,
  tenantIds: Record<string, string>,
): Promise<void> {
  const buckets = await engineBuckets(orgId);
  if (buckets.length === 0) return;

  let client;
  try {
    client = getRagEngineClient();
  } catch (error) {
    console.warn(`${LOG} no engine on this stage, leaving datasets to tenant deletion`, {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const { region, bucketName } of buckets) {
    try {
      const orchestrator = getOrchestratorForRegion(region);
      const tenantId = tenantIds[orchestrator.id];
      if (!tenantId) continue;
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
}

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
