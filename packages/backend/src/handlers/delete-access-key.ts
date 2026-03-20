import { DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { deleteAuroraAccessKey } from '../lib/aurora-portal.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
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

  // Look up org profile to get auroraTenantId
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  await deleteAuroraAccessKey({ tenantId: auroraTenantId, auroraKeyId: keyId });

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
