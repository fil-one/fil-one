import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { triggerTenantSetup } from '../lib/trigger-tenant-setup.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { suggestOrgName } from '../lib/suggest-org-name.js';
import {
  deleteAuthenticationMethod,
  getConnectionType,
  getMfaEnrollments,
  setEmailMfaActive,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, email, emailVerified, sub, name, picture } = getUserInfo(event);

  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );

  const setupStatus = Item?.setupStatus?.S;
  const orgName = Item?.name?.S ?? '';
  const orgConfirmed = Item?.orgConfirmed?.BOOL === true;

  if (orgConfirmed && !isOrgSetupComplete(setupStatus)) {
    try {
      await triggerTenantSetup({ orgId, orgName });
    } catch (error) {
      console.error('[get-me] Failed to trigger tenant setup', { error, orgId });
    }
  }

  const connectionType = getConnectionType(sub);

  const includeMfa = event.queryStringParameters?.include === 'mfa';
  let enrollments = includeMfa ? await getMfaEnrollments(sub, { includeEmail: true }) : [];

  // Email cannot coexist with a strong factor — Auth0 may attach an email
  // authentication-method automatically after OTP/WebAuthn enrollment because
  // the user's email is verified. Drop and delete the orphan so settings and
  // login both reflect the actual policy (strong factor wins). Also clear
  // the email_mfa_active flag so the Post-Login Action does not later treat
  // the still-auto-enrolled email factor as a real one.
  if (enrollments.some((e) => e.type !== 'email')) {
    const orphaned = enrollments.filter((e) => e.type === 'email');
    if (orphaned.length > 0) {
      await Promise.all(orphaned.map((e) => deleteAuthenticationMethod(sub, e.id)));
      await setEmailMfaActive(sub, false);
      enrollments = enrollments.filter((e) => e.type !== 'email');
    }
  }

  const body: MeResponse = {
    orgId,
    orgName,
    orgConfirmed,
    emailVerified,
    email,
    orgSetupComplete: isOrgSetupComplete(setupStatus),
    name,
    mfaEnrollments: enrollments.map((e) => ({
      id: e.id,
      type: e.type as 'authenticator' | 'webauthn-roaming' | 'webauthn-platform' | 'email',
      name: e.name,
      createdAt: e.enrolled_at ?? '',
    })),
    picture,
    connectionType,
  };

  // Only include suggested name if org is not yet confirmed
  if (!orgConfirmed && email) {
    body.suggestedOrgName = suggestOrgName(email);
  }

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
