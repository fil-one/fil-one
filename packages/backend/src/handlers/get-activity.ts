import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { RecentActivity, RecentActivityResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import type { ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import { ProvisionedRegion, getProvisionedRegions } from '../lib/region-helpers.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  // The dashboard aggregates activity across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const regions = await getProvisionedRegions(orgId);

  const [bucketActivities, keyActivities] = await Promise.all([
    fetchBucketActivities(orgId, regions),
    fetchAccessKeyActivities(orgId),
  ]);

  // TODO: Re-add object activities once we have an event system with Aurora.
  // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard

  const activities = [...bucketActivities, ...keyActivities].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const response: RecentActivityResponse = {
    activities: activities.slice(0, limit),
  };
  return new ResponseBuilder().status(200).body(response).build();
}

async function fetchBucketActivities(
  orgId: string,
  regions: ProvisionedRegion[],
): Promise<RecentActivity[]> {
  const perRegion = await Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      listBucketActivities(orgId, orchestrator, tenantId),
    ),
  );
  return perRegion.flat();
}

async function listBucketActivities(
  orgId: string,
  orchestrator: ServiceOrchestrator,
  tenantId: string,
): Promise<RecentActivity[]> {
  // Swallow per-orchestrator errors so one region's outage still renders the rest.
  try {
    // This feed only reads bucketName/createdAt, so skip the per-bucket
    // versioning lookups (an N+1 on FTH) that would otherwise dominate latency.
    const buckets = await orchestrator.listBuckets(tenantId, { includeVersioning: false });
    return buckets.map((bucket) => ({
      id: `bucket-${bucket.bucketName}`,
      action: 'bucket.created' as const,
      resourceType: 'bucket' as const,
      resourceName: bucket.bucketName,
      timestamp: bucket.createdAt,
    }));
  } catch (err) {
    const errName = (err as { name?: string }).name;
    const errCode = (err as { Code?: string }).Code;
    if (errName === 'AccessDenied' || errCode === 'AccessDenied') {
      console.warn('[get-activity] AccessDenied listing buckets — tenant may have no buckets yet', {
        orgId,
        tenantId,
        region: orchestrator.region,
      });
    } else {
      console.error('[get-activity] Failed to list buckets', {
        orgId,
        tenantId,
        region: orchestrator.region,
        err,
      });
    }
    return [];
  }
}

async function fetchAccessKeyActivities(orgId: string): Promise<RecentActivity[]> {
  const keysResult = await dynamo.send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    }),
  );
  return (keysResult.Items ?? []).map((item) => {
    const key = unmarshall(item) as AccessKeyRecord;
    return {
      id: `key-${key.sk.replace('ACCESSKEY#', '')}`,
      action: 'key.created' as const,
      resourceType: 'key' as const,
      resourceName: key.keyName,
      timestamp: key.createdAt,
    };
  });
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
