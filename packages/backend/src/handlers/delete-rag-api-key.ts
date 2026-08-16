import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, auditEvent, commitAudited } from '../lib/audit.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { keyScope, notYourKeyResponse, withinScope } from '../lib/key-scope.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

function notFoundResponse(): APIGatewayProxyResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'API key not found' })
    .build();
}

/**
 * Delete a RAG API key. Ownership proof is structural: the lookup runs under
 * the caller's own `ORG#{orgId}` partition, so a keyId belonging to another
 * org can never resolve. Within the org, a caller holding only
 * `keys.manage_own` reaches the keys they created and no others. Both rows (ORG
 * record + hash LOOKUP row) are removed in one transaction — bearer auth reads
 * the LOOKUP row with a consistent read, so revocation takes effect
 * immediately.
 */
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const keyId = event.pathParameters?.keyId;
  if (!keyId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing keyId in path' })
      .build();
  }

  const { orgId, userId } = getUserInfo(event);
  const email = getVerifiedEmail(event);

  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: RagApiKeyKeys.orgPk(orgId), sk: RagApiKeyKeys.orgSk(keyId) }),
    }),
  );
  const tokenHash = Item?.tokenHash?.S;
  if (!tokenHash) return notFoundResponse();

  // Revoking is `keys.manage_own` unless the caller holds `keys.manage_all`, so
  // a Member revokes the keys they minted and no others.
  if (!withinScope(keyScope(event), { createdBy: Item?.createdBy?.S })) return notYourKeyResponse();

  const keyName = Item?.keyName?.S;

  try {
    await commitAudited({
      items: [
        {
          Delete: {
            TableName: Resource.UserInfoTable.name,
            Key: marshall({ pk: RagApiKeyKeys.orgPk(orgId), sk: RagApiKeyKeys.orgSk(keyId) }),
            ConditionExpression: 'attribute_exists(pk)',
          },
        },
        {
          Delete: {
            TableName: Resource.UserInfoTable.name,
            Key: marshall({
              pk: RagApiKeyKeys.lookupPk(tokenHash),
              sk: RagApiKeyKeys.lookupSk(),
            }),
            // The lookup row must point back at the caller's org, or the
            // whole transaction cancels.
            ConditionExpression: 'orgId = :orgId',
            ExpressionAttributeValues: { ':orgId': { S: orgId } },
          },
        },
      ],
      event: auditEvent({
        type: 'key.revoked',
        actor: { kind: 'user', id: userId, ...(email ? { email } : {}) },
        orgId,
        subject: AuditSubjects.key(keyId),
        details: { keyKind: 'rag', ...(keyName ? { keyName } : {}) },
      }),
    });
  } catch (err) {
    // A concurrent delete of the same key cancels the transaction — the key is
    // gone either way, so report it as not found rather than a server error.
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      return notFoundResponse();
    }
    throw err;
  }

  return { statusCode: 204, body: '' };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
