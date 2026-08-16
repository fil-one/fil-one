import { GetItemCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateOrgSchema } from '@filone/shared';
import type { AuditActor, ErrorResponse, UpdateOrgResponse } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, auditEvent, commitAudited } from '../lib/audit.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * The wire shape with the stored shape's sanitization folded in, so one parse
 * produces the value that gets written. Escaping belongs inside the same schema
 * rather than in a second pass over the result: `ORG_NAME_PATTERN` already
 * rejects every character `validator.escape` would touch, so a second parse of
 * the escaped name has no reachable failure branch to report.
 */
const UpdateOrgBodySchema = UpdateOrgSchema.extend({ name: SanitizedOrgNameSchema });

/**
 * PATCH /api/org — rename the organization.
 *
 * Its own route because its requirement is its own: renaming an org is
 * `org.rename`, held by Owner and Admin, while the profile fields it used to
 * share a body with are things any member changes about themselves. One route
 * carrying both would have to choose between locking a ReadOnly member out of
 * their own name and letting them rename the company.
 *
 * Rename is the only verb here. Ownership transfer and deletion are their own
 * permissions and their own routes when they ship.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  // Verified only, and this route runs without the verified-email gate, so it
  // is often absent — the audit actor's id is the userId either way.
  const email = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, UpdateOrgBodySchema);
  if ('error' in parsed) return parsed.error;
  const { name } = parsed.data;

  try {
    await renameOrg({
      orgId,
      name,
      actor: { kind: 'user', id: userId, ...(email ? { email } : {}) },
    });
  } catch (err) {
    // The row the rename is conditional on is gone: the org was deleted between
    // the session being minted and this request, which is a 404 rather than a
    // 500. The condition now fails inside a transaction, so it arrives as a
    // cancellation rather than as a bare conditional-check failure.
    if (err instanceof TransactionCanceledException) {
      return new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Organization not found' })
        .build();
    }
    throw err;
  }

  return new ResponseBuilder().status(200).body<UpdateOrgResponse>({ name }).build();
}

/**
 * Write the new name and the event that records it, in one transaction.
 *
 * The read comes first because the previous name is what the event needs and
 * only a read can supply it: `UPDATED_OLD` returns nothing when the attribute
 * was absent, and every org created before naming shipped has no `name` on its
 * profile row, so the event would record a rename with no predecessor. The
 * write stays conditional on the row, so a rename can never conjure an org.
 *
 * The pair being a transaction is the point: a rename that reached the profile
 * row without reaching the log would be a change to the org nobody can see.
 */
async function renameOrg({
  orgId,
  name,
  actor,
}: {
  orgId: string;
  name: string;
  actor: AuditActor;
}): Promise<void> {
  const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ProjectionExpression: '#name',
      ExpressionAttributeNames: { '#name': 'name' },
      ConsistentRead: true,
    }),
  );
  const previousName = Item?.name?.S;

  await commitAudited({
    items: [
      {
        Update: {
          TableName: Resource.UserInfoTable.name,
          Key: key,
          UpdateExpression: 'SET #name = :name',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: { ':name': { S: name } },
        },
      },
    ],
    event: auditEvent({
      type: 'org.renamed',
      actor,
      orgId,
      subject: AuditSubjects.org(orgId),
      details: { name, ...(previousName ? { previousName } : {}) },
    }),
  });
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate, as `update-profile` does: the Settings
  // page carries both forms, and a user who mistyped their address on signup
  // has to be able to use it. Renaming the org changes nothing about the
  // caller's identity, so nothing here can be used to bypass verification.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(authorize('org.rename'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
