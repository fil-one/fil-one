import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@hyperspace/shared';
import { Resource } from 'sst';
import { OrgSetupStatus } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = new DynamoDBClient({});

async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyResultV2> {
  const { orgId, email } = getUserInfo(event);

  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );

  const setupStatus = Item?.setupStatus?.S;

  const body: MeResponse = {
    orgId,
    email,
    auroraTenantReady: setupStatus === OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
