import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { PreferencesResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { getMarketingPreference } from '../lib/hubspot-client.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

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
