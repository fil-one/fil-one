import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { deleteAuthenticationMethod, getPasskeyAuthenticators } from '../lib/auth0-management.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { requireMfa } from '../middleware/require-mfa.ts';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);
  const methodId = event.pathParameters?.methodId;

  if (!methodId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Passkey ID is required.' })
      .build();
  }

  // Re-fetch the user's passkeys to verify the id belongs to them — prevents
  // a session from being used to delete another user's authentication method
  // if they could guess an id.
  const passkeys = await getPasskeyAuthenticators(sub);
  const passkey = passkeys.find((p) => p.id === methodId);
  if (!passkey) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Passkey not found.' })
      .build();
  }

  await deleteAuthenticationMethod(sub, methodId);

  return new ResponseBuilder().status(200).body({ message: 'Passkey removed.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireMfa())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
