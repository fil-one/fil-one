import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { sendVerificationEmail } from '../lib/auth0-management.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub, emailVerified } = getUserInfo(event);

  if (emailVerified) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Email is already verified.' })
      .build();
  }

  await sendVerificationEmail(sub);

  return new ResponseBuilder().status(200).body({ message: 'Verification email sent.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
