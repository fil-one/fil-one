import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UpdateProfileResponse, ErrorResponse } from '@filone/shared';
import { UpdateProfileSchema, isSocialConnection } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { validateOrgName } from '../lib/org-name-validation.js';
import {
  updateAuth0User,
  sendVerificationEmail,
  getConnectionType,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, requestTokenRefresh } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, sub } = getUserInfo(event);
  const body = JSON.parse(event.body ?? '{}') as unknown;

  const parsed = UpdateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const connectionType = getConnectionType(sub);
  const social = isSocialConnection(connectionType);
  const response: UpdateProfileResponse = {};

  if (parsed.data.name !== undefined) {
    if (social) {
      return new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({
          message: 'Name cannot be changed for social login accounts. Update it at your provider.',
        })
        .build();
    }
    await updateAuth0User(sub, { name: parsed.data.name });
    response.name = parsed.data.name;
  }

  if (parsed.data.email !== undefined) {
    if (social) {
      return new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({
          message: 'Email cannot be changed for social login accounts. Update it at your provider.',
        })
        .build();
    }
    await updateAuth0User(sub, { email: parsed.data.email, email_verified: false });
    await sendVerificationEmail(sub);
    response.email = parsed.data.email;
  }

  if (parsed.data.orgName !== undefined) {
    const result = validateOrgName(parsed.data.orgName);
    if (!result.valid) {
      return new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: result.error! })
        .build();
    }

    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
        },
        UpdateExpression: 'SET #name = :name',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: {
          ':name': { S: result.sanitized },
        },
      }),
    );
    response.orgName = result.sanitized;
  }

  if (response.name !== undefined || response.email !== undefined) {
    requestTokenRefresh(event);
  }

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
