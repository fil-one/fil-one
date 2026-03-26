import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getConnectionType, initiatePasswordReset } from '../lib/auth0-management.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub, email } = getUserInfo(event);

  const connectionType = getConnectionType(sub);
  if (connectionType !== 'auth0') {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Password change is not available for social login accounts.',
      })
      .build();
  }

  if (!email) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'No email associated with this account.' })
      .build();
  }

  const secrets = getAuthSecrets();

  try {
    await initiatePasswordReset(email, secrets.AUTH0_CLIENT_ID);
  } catch (error) {
    console.error('[change-password] Auth0 change_password failed', { error });
    return new ResponseBuilder()
      .status(502)
      .body<ErrorResponse>({ message: 'Failed to initiate password change.' })
      .build();
  }

  return new ResponseBuilder().status(200).body({ message: 'Password reset email sent.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
