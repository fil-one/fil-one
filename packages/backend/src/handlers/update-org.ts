import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateOrgSchema } from '@filone/shared';
import type { ErrorResponse, UpdateOrgResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

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

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = UpdateOrgSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const sanitized = SanitizedOrgNameSchema.safeParse(parsed.data.name);
  if (!sanitized.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: sanitized.error.issues[0].message })
      .build();
  }

  const previousName = await renameOrg(orgId, sanitized.data);

  // Both names, because the audit event this becomes (`org.renamed`, in the
  // audit-write-path PR) records what the org was called as well as what it is
  // called now, and the update above is the only place the old value exists.
  console.log('[update-org] Organization renamed', {
    orgId,
    actorUserId: userId,
    previousName,
    name: sanitized.data,
  });

  return new ResponseBuilder()
    .status(200)
    .body<UpdateOrgResponse>({ name: sanitized.data })
    .build();
}

/**
 * Write the new name, returning the old one. Conditional on the profile row
 * existing so a rename can never conjure an org.
 */
async function renameOrg(orgId: string, name: string): Promise<string | undefined> {
  const { Attributes } = await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET #name = :name',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':name': { S: name } },
      ReturnValues: 'UPDATED_OLD',
    }),
  );
  return Attributes?.name?.S;
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('org.rename'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
