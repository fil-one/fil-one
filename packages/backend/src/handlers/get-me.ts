import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  getConnectionType,
  getMfaEnrollments,
  getPasskeyAuthenticators,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, email, emailVerified, sub, name, picture } = getUserInfo(event);

  const includeMfa = event.queryStringParameters?.include === 'mfa';
  const connectionType = getConnectionType(sub);

  const [orgProfile, enrollments, passkeys] = await Promise.all([
    getOrgProfile(orgId),
    includeMfa ? getMfaEnrollments(sub) : Promise.resolve([]),
    includeMfa && connectionType === 'auth0' ? getPasskeyAuthenticators(sub) : Promise.resolve([]),
  ]);

  const orgName = orgProfile?.name?.S ?? '';

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
    ...(includeMfa && {
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.created_at && { createdAt: p.created_at }),
      })),
    }),
    picture,
    connectionType,
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate: the frontend relies on /me to detect
  // the unverified state and drive the verify-email flow.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(errorHandlerMiddleware());
