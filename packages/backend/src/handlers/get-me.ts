import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@hyperspace/shared';
import { Resource } from 'sst';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { suggestOrgName } from '../lib/suggest-org-name.js';
import { getDynamoClient } from '../lib/ddb-client.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, orgId, email } = getUserInfo(event);

  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );

  const setupStatus = Item?.setupStatus?.S;
  const orgName = Item?.name?.S ?? '';
  const orgConfirmed = Item?.orgConfirmed?.BOOL === true;

  const body: MeResponse = {
    orgId,
    orgName,
    orgConfirmed,
    email,
    orgSetupComplete: isOrgSetupComplete(setupStatus),
  };

  // Only include suggested name if org is not yet confirmed
  if (!orgConfirmed) {
    body.suggestedOrgName = suggestOrgName(email, userId);
  }

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
