import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getConnectionType, getMfaEnrollments } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, email, emailVerified, sub, name, picture } = getUserInfo(event);

  const includeMfa = event.queryStringParameters?.include === 'mfa';

  const [{ Item }, enrollments] = await Promise.all([
    getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
        },
      }),
    ),
    includeMfa ? getMfaEnrollments(sub) : Promise.resolve([]),
  ]);

  const orgName = Item?.name?.S ?? '';

  const connectionType = getConnectionType(sub);

  const body: MeResponse = {
    orgId,
    orgName,
    emailVerified,
    email,
    name,
    mfaEnrollments: enrollments.map((e) => ({
      id: e.id,
      type: e.type as 'authenticator' | 'webauthn-roaming' | 'webauthn-platform',
      name: e.name,
      ...(e.enrolled_at && { createdAt: e.enrolled_at }),
    })),
    picture,
    connectionType,
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
