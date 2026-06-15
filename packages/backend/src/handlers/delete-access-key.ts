import { DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ErrorResponse, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder, tenantNotReadyResponse } from '../lib/response-builder.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const keyId = event.pathParameters?.keyId;
  if (!keyId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing keyId in path' })
      .build();
  }

  const { orgId } = getUserInfo(event);

  // Verify the key belongs to this org
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: `ACCESSKEY#${keyId}` }),
    }),
  );

  if (!Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Access key not found' })
      .build();
  }

  // Legacy rows written before multi-region routing don't carry a `region`
  // attribute — those predate FTH, so they belong to Aurora (eu-west-1).
  const region: S3Region = (Item.region?.S as S3Region | undefined) ?? S3Region.EuWest1;
  const orchestrator = getOrchestratorForRegion(region);

  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  await orchestrator.deleteAccessKey(tenantId, keyId);

  await dynamo.send(
    new DeleteItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: `ACCESSKEY#${keyId}` }),
    }),
  );

  return { statusCode: 204, body: '' };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
