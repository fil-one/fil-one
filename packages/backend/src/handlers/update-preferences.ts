import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { PreferencesResponse, ErrorResponse } from '@filone/shared';
import { UpdatePreferencesSchema } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { syncMarketingPreference } from '../lib/hubspot-client.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, email } = getUserInfo(event);

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = UpdatePreferencesSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const { marketingEmailsOptedIn } = parsed.data;

  if (email) {
    await syncMarketingPreference(email, marketingEmailsOptedIn);
  }

  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `USER#${userId}` },
        sk: { S: 'PROFILE' },
      },
      UpdateExpression: 'SET marketingEmailsOptedIn = :val',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':val': { BOOL: marketingEmailsOptedIn },
      },
    }),
  );

  return new ResponseBuilder()
    .status(200)
    .body<PreferencesResponse>({ marketingEmailsOptedIn })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
