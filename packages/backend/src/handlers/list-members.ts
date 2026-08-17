import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Resource } from 'sst';
import type { ListMembersResponse, MemberSummary } from '@filone/shared';
import { getDynamoClient } from '../lib/ddb-client.js';
import { listMembers } from '../lib/org-membership.js';
import type { OrgMembership } from '../lib/org-membership.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * GET /api/org/members — who is in the organization, and as what.
 *
 * One Query on the org's partition plus a profile `GetItem` per member, which is
 * the access pattern OrgTable was chosen for. Every role may read it: a member
 * who cannot see who else is in the org cannot tell who to ask for anything, and
 * the matrix grants `members.read` to all four.
 *
 * The honest state of the display fields: a user's name and email live in Auth0,
 * and the row we hold for a user (`USER#{userId}/PROFILE`) records their `sub`,
 * their org, and when it was created — no name, no address. So the profile read
 * fills `name` and `email` when the row has learned them and the response
 * carries ids and roles when it has not. Reading the rows anyway is what makes
 * the day they carry more a data change rather than an API change; resolving
 * identities through the Auth0 Management API instead would be one call per
 * member on a page the console loads often, and is the alternative to weigh when
 * the console PR decides how it wants to name people.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  const members = await listMembers(orgId);
  const summaries = await Promise.all(members.map(summarize));

  return new ResponseBuilder()
    .status(200)
    .body<ListMembersResponse>({
      // Longest-standing first, and a member with no `joinedAt` — every row
      // written before the attribute existed — sorts last rather than first.
      members: summaries.sort((left, right) =>
        (left.joinedAt ?? '9999').localeCompare(right.joinedAt ?? '9999'),
      ),
    })
    .build();
}

async function summarize(member: OrgMembership): Promise<MemberSummary> {
  const profile = await readUserProfile(member.userId);

  return {
    userId: member.userId,
    role: member.role,
    ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
    ...(member.source ? { source: member.source } : {}),
    ...(member.invitedBy ? { invitedBy: member.invitedBy } : {}),
    ...(profile?.email ? { email: profile.email } : {}),
    ...(profile?.name ? { name: profile.name } : {}),
  };
}

/**
 * The member's own profile row, or undefined when it cannot be read.
 *
 * A failed read costs that member their display fields rather than the whole
 * roster: the row that says they are a member has already been read, and a page
 * that renders everyone but one name beats a page that renders nobody.
 */
async function readUserProfile(
  userId: string,
): Promise<{ email?: string; name?: string } | undefined> {
  try {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        ProjectionExpression: 'email, #name',
        ExpressionAttributeNames: { '#name': 'name' },
      }),
    );
    return { email: Item?.email?.S, name: Item?.name?.S };
  } catch (err) {
    console.error('[list-members] Profile read failed — listing the member unnamed', {
      userId,
      error: err,
    });
    return undefined;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.read'))
  .use(errorHandlerMiddleware());
