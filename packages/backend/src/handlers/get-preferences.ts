import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { PreferencesResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getMarketingPreference } from '../lib/hubspot-client.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { email } = getUserInfo(event);

  // Without an email we cannot identify the contact in HubSpot. Treat as opted-out.
  if (!email) {
    return new ResponseBuilder()
      .status(200)
      .body<PreferencesResponse>({ marketingEmailsOptedIn: false })
      .build();
  }

  const marketingEmailsOptedIn = await getMarketingPreference(email);

  return new ResponseBuilder()
    .status(200)
    .body<PreferencesResponse>({ marketingEmailsOptedIn })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
