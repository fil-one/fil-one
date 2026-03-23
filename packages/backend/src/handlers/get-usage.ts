import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import {
  getStorageSamples,
  getOperationsSamples,
  getTenantInfo,
} from '../lib/aurora-backoffice.js';

const dynamo = getDynamoClient();

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId } = getUserInfo(event);
  const userInfoTableName = Resource.UserInfoTable.name;

  // 1. Look up org profile for Aurora S3 credentials
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: userInfoTableName,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;

  // 2. Fetch usage data from Aurora in parallel
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const shouldFetchData = auroraTenantId && isOrgSetupComplete(setupStatus);

  const [storageSamples, operationsSamples, tenantInfo] = await Promise.all([
    shouldFetchData
      ? getStorageSamples({
          tenantId: auroraTenantId,
          from: thirtyDaysAgo.toISOString(),
          to: now.toISOString(),
          window: '720h',
        })
      : [],
    shouldFetchData
      ? getOperationsSamples({
          tenantId: auroraTenantId,
          from: thirtyDaysAgo.toISOString(),
          to: now.toISOString(),
          window: '720h',
        })
      : [],
    shouldFetchData ? getTenantInfo({ tenantId: auroraTenantId }) : null,
  ]);

  const latestStorage = storageSamples.at(-1);
  const storageUsedBytes = latestStorage?.bytesUsed ?? 0;
  const objectCount = latestStorage?.objectCount ?? 0;

  const egressSample = operationsSamples.at(-1);
  const egressUsedBytes = egressSample?.rxBytes ?? 0;

  const bucketCount = tenantInfo?.bucketCount ?? 0;
  const bucketLimit = tenantInfo?.bucketQuantityLimit ?? 100;
  const accessKeyCount = tenantInfo?.keyCount ?? 0;
  const accessKeyLimit = tenantInfo?.accessKeyQuantityLimit ?? 300;

  const response: UsageResponse = {
    storage: { usedBytes: storageUsedBytes },
    egress: { usedBytes: egressUsedBytes },
    buckets: { count: bucketCount, limit: bucketLimit },
    objects: { count: objectCount },
    accessKeys: { count: accessKeyCount, limit: accessKeyLimit },
    tenantStatus: tenantInfo?.status,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
