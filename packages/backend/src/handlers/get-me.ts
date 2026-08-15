import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';
import { getOrgProfile } from '../lib/org-profile.js';
import { listMemberships } from '../lib/org-membership.js';
import type { OrgMembershipRecord } from '../lib/org-membership.js';
import { hasRagAccess } from '../middleware/rag-access.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  getConnectionType,
  getMfaEnrollments,
  getPasskeyAuthenticators,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * Names each membership for the org switcher. The active org's name is already
 * in hand; every other org costs one profile GetItem, which stays cheap while a
 * second membership can only arrive through an invitation.
 */
async function summarizeMemberships(
  memberships: OrgMembershipRecord[],
  activeOrgId: string,
  activeOrgName: string,
): Promise<OrgMembershipSummary[]> {
  return Promise.all(
    memberships.map(async (membership) => ({
      orgId: membership.orgId,
      orgName:
        membership.orgId === activeOrgId
          ? activeOrgName
          : ((await getOrgProfile(membership.orgId))?.name?.S ?? ''),
      role: membership.role,
    })),
  );
}

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId, email, emailVerified, sub, name, picture, membership, permissions } =
    getUserInfo(event);

  const includeMfa = event.queryStringParameters?.include === 'mfa';
  const connectionType = getConnectionType(sub);

  // Verified-only — never gate access off an unverified email claim.
  const verifiedEmail = getVerifiedEmail(event);

  const [orgProfile, enrollments, passkeys, ragAccess, memberships] = await Promise.all([
    getOrgProfile(orgId),
    includeMfa ? getMfaEnrollments(sub) : Promise.resolve([]),
    includeMfa && connectionType === 'auth0' ? getPasskeyAuthenticators(sub) : Promise.resolve([]),
    hasRagAccess(verifiedEmail),
    listMemberships(userId),
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
    ragAccess,
    userId,
    ...(membership && { role: membership.role }),
    permissions: [...(permissions ?? [])],
    memberships: await summarizeMemberships(memberships, orgId, orgName),
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate: the frontend relies on /me to detect
  // the unverified state and drive the verify-email flow.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(errorHandlerMiddleware());
