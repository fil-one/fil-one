import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { permissionsForRole } from '@filone/shared';
import { getOrgProfile } from '../lib/org-profile.js';
import { summarizeMemberships } from '../lib/org-membership.js';
import { hasRagAccess } from '../middleware/rag-access.js';
import { hasOrgsBetaAccess } from '../lib/orgs-beta.js';
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

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId, email, emailVerified, sub, name, picture, membership } =
    getUserInfo(event);

  const includeMfa = event.queryStringParameters?.include === 'mfa';
  const connectionType = getConnectionType(sub);

  // Verified-only — never gate access off an unverified email claim.
  const verifiedEmail = getVerifiedEmail(event);

  // The switcher names the active org from this same read rather than a second
  // one, so the memberships join the round of reads already in flight.
  //
  // Consistent, because the org this request names may be one the caller just
  // created — signup, or "create organization" followed immediately by a
  // switch into it — and an eventually-consistent read racing that write can
  // still answer with nothing, naming and slugging the org empty on the very
  // response that is supposed to introduce it.
  const activeOrgProfile = getOrgProfile(orgId, { consistentRead: true });

  const [orgProfile, enrollments, passkeys, ragAccess, orgsBeta, memberships] = await Promise.all([
    activeOrgProfile,
    includeMfa ? getMfaEnrollments(sub) : Promise.resolve([]),
    includeMfa && connectionType === 'auth0' ? getPasskeyAuthenticators(sub) : Promise.resolve([]),
    hasRagAccess(verifiedEmail),
    // The same predicate `POST /api/org/invitations` refuses on, asked here so
    // the console can leave the surface out rather than render it and collect a
    // 403 from the first thing the caller reaches for.
    hasOrgsBetaAccess({ verifiedEmail, orgId }),
    summarizeMemberships({
      userId,
      activeOrgId: orgId,
      activeRole: membership?.role,
      activeOrgSummary: activeOrgProfile.then((profile) => ({
        name: profile?.name?.S ?? '',
        slug: profile?.slug?.S ?? '',
        ...(profile?.logoUrl?.S ? { logoUrl: profile.logoUrl.S } : {}),
      })),
    }),
  ]);

  const orgName = orgProfile?.name?.S ?? '';
  const slug = orgProfile?.slug?.S ?? '';
  const orgLogoUrl = orgProfile?.logoUrl?.S;
  // Absent means an organization that predates the field, which is treated as
  // named: only an explicit false sends the caller through the naming step.
  const nameConfirmed = orgProfile?.nameConfirmed?.BOOL !== false;

  const body: MeResponse = {
    orgId,
    orgName,
    slug,
    ...(orgLogoUrl ? { logoUrl: orgLogoUrl } : {}),
    nameConfirmed,
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
    // Derived from the role on the way out rather than cached beside it, and
    // handed over as the registry's own frozen row — the console reads it, the
    // server enforces it, and neither gets a copy that can drift.
    permissions: permissionsForRole(membership?.role ?? ''),
    memberships,
    orgsBeta,
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate: the frontend relies on /me to detect
  // the unverified state and drive the verify-email flow.
  //
  // `orgHeaderFallback` is this route's alone. The console keeps the active org
  // per tab, and this response is what tells it the stash has gone stale — an
  // org the caller was removed from, or one that was deleted. Refusing the
  // request would leave the console reading a 403 from the only endpoint that
  // could have told it which org it should be in. Every other route answers a
  // stale stash with the ordinary 403, which sends the console here.
  .use(authMiddleware({ requireVerifiedEmail: false, orgHeaderFallback: true }))
  .use(errorHandlerMiddleware());
