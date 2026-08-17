import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListInvitationsResponse } from '@filone/shared';
import { invitationSummary, listInvitations } from '../lib/invitations.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * GET /api/org/invitations — the invitations still waiting on somebody.
 *
 * Pending rows only, newest first, with `expired` computed here from
 * `expiresAt`. Expiry is not a status, so an expired invitation is still a
 * pending row: it is listed, flagged, and revocable, because "nobody ever
 * accepted and the link has run out" is exactly what the person looking at this
 * page is trying to find out. Accepted and revoked rows stay out of it — they
 * are history, and history is the audit log's job (FIL-1022).
 *
 * Gated on `members.manage` rather than `members.read`: the list is a set of
 * email addresses of people who are not in the org, which is the inviting side's
 * business rather than every member's.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const now = new Date();

  const invitations = (await listInvitations(orgId))
    .filter((invitation) => invitation.status === 'pending')
    .map((invitation) => invitationSummary(invitation, now))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return new ResponseBuilder().status(200).body<ListInvitationsResponse>({ invitations }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(errorHandlerMiddleware());
