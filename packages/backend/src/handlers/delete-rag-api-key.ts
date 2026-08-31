import { GetItemCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { auditKeyIdSuffix } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
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
  const keyPrefix = Item?.keyPrefix?.S;

  try {
    // Best-effort on the audit half: an AuditTable outage must never be the
    // reason a leaked key stays live, so a cancellation on the event alone
    // lands the two deletes without it and counts the dropped event. What
    // reaches the catch is therefore a cancellation on the caller's own items.
    await commitAudited({
      onAuditFailure: 'retry-without-audit',
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
        type: 'key.deleted',
        actor: userActor({ userId, email }),
        orgId,
        // The display prefix the details also carry, so both halves of the
        // event name the key the way the console lists it. A row written
        // before the prefix was stored has none, and the internal key id is
        // better than no subject at all.
        subject: AuditSubjects.key('rag', keyPrefix ?? keyId),
        details: {
          keyKind: 'rag',
          ...(keyName ? { keyName } : {}),
          ...(keyPrefix ? { keyIdSuffix: auditKeyIdSuffix('rag', keyPrefix) } : {}),
        },
      }),
    });
  } catch (err) {
    // A concurrent delete of the same key fails the deletes' own conditions —
    // the key is gone either way, so report it as not found rather than a
    // server error.
    if (deleteConditionFailed(err)) return notFoundResponse();
    throw err;
  }

  return { statusCode: 204, body: '' };
}

/**
 * The ORG record and the hash LOOKUP row, which lead the transaction: the audit
 * event is appended after them, and the retry that drops the event sends these
 * two alone. Either way their cancellation reasons are the first two.
 */
const DELETE_ITEM_COUNT = 2;

/**
 * Whether the deletes' own conditions are what cancelled the transaction.
 *
 * Only `ConditionalCheckFailed` on the delete items means the rows went away
 * under this request. A `TransactionConflict` or a throttle cancels the same
 * items and means the opposite: nothing was deleted, the LOOKUP row still
 * authorises the key, and a retry may still land — so a 404 there reports a
 * live key as revoked and hides a retryable failure from the caller. The audit
 * item's own failures never reach here: `commitAudited` retries the deletes
 * without the event.
 */
function deleteConditionFailed(err: unknown): boolean {
  if (!(err instanceof TransactionCanceledException)) return false;
  const cancelled = (err.CancellationReasons ?? [])
    .slice(0, DELETE_ITEM_COUNT)
    .map((reason) => reason.Code)
    .filter((code) => code && code !== 'None');
  return cancelled.length > 0 && cancelled.every((code) => code === 'ConditionalCheckFailed');
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
