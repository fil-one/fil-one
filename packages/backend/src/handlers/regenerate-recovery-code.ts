import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse, RegenerateRecoveryCodeResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getMfaEnrollments, regenerateRecoveryCode } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfa } from '../middleware/require-mfa.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  const enrollments = await getMfaEnrollments(sub);
  if (enrollments.length === 0) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'MFA is not currently enabled.' })
      .build();
  }

  const recoveryCode = await regenerateRecoveryCode(sub);

  return new ResponseBuilder()
    .status(200)
    .body<RegenerateRecoveryCodeResponse>({
      recoveryCode,
      message: 'New recovery code generated. The previous code has been invalidated.',
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireMfa())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
