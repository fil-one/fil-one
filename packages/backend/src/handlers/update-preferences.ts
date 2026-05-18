import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { PreferencesResponse, ErrorResponse } from '@filone/shared';
import { UpdatePreferencesSchema } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID,
  updateSubscriptionStatus,
} from '../lib/hubspot-client.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { email } = getUserInfo(event);

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

  if (!email) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Email is required to update marketing preferences' })
      .build();
  }

  const { marketingEmailsOptedIn } = parsed.data;
  await updateSubscriptionStatus(
    email,
    HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID,
    marketingEmailsOptedIn,
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
