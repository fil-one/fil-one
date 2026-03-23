import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { triggerTenantSetup } from '../lib/trigger-tenant-setup.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { suggestOrgName } from '../lib/suggest-org-name.js';
import { getConnectionType } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, email, emailVerified, sub, name, picture } = getUserInfo(event);

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

  if (orgConfirmed && !isOrgSetupComplete(setupStatus)) {
    try {
      await triggerTenantSetup({ orgId, orgName });
    } catch (error) {
      console.error('[get-me] Failed to trigger tenant setup', { error, orgId });
    }
  }

  const body: MeResponse = {
    orgId,
    orgName,
    orgConfirmed,
    emailVerified,
    email,
    orgSetupComplete: isOrgSetupComplete(setupStatus),
    name,
    picture,
    connectionType: getConnectionType(sub),
  };

  // Only include suggested name if org is not yet confirmed
  if (!orgConfirmed && email) {
    body.suggestedOrgName = suggestOrgName(email);
  }

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
