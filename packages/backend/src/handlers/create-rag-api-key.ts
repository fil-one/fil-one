import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateRagApiKeySchema } from '@filone/shared';
import type { CreateRagApiKeyResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { accountDeletedResponse } from '../lib/account-deleted-response.js';
import { OrgDeletingError, sendFencedWrite } from '../lib/org-profile.js';
import {
  RagApiKeyKeys,
  generateRagKeyToken,
  hashRagKeyToken,
  ragKeyDisplayPrefix,
} from '../lib/rag-api-keys.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ragAccessMiddleware } from '../middleware/rag-access.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

/**
 * Create a RAG API key: a bearer token scoped to the RAG query endpoint.
 *
 * The token is generated here (not by a storage orchestrator — RAG keys are a
 * fil-one-level credential) and returned exactly once in the 201 response;
 * only its SHA-256 hash is persisted. Scoped buckets are NOT validated against
 * the orchestrator: scope can only narrow what the key's org already owns, and
 * ownership is enforced at query time by the tenant-scoped bucket lookup.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = CreateRagApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const { keyName, bucketScope } = parsed.data;
  const buckets = bucketScope === 'specific' ? parsed.data.buckets : undefined;

  const { orgId, userId } = getUserInfo(event);
  // Stored so bearer requests re-check the creator's RAG allowlist entry and
  // region entitlement live. Verified-only — never the raw claim.
  const creatorEmail = getVerifiedEmail(event);

  const keyId = crypto.randomUUID();
  const token = generateRagKeyToken();
  const tokenHash = hashRagKeyToken(token);
  const keyPrefix = ragKeyDisplayPrefix(token);
  const createdAt = new Date().toISOString();

  // Both rows or neither: the ORG record (listing/ownership) and the hash
  // LOOKUP row (bearer-auth entry point) must never diverge.
  //
  // FIL-112: the transaction is additionally fenced on the org's `deleting`
  // flag (sendFencedWrite). Without it, `attribute_not_exists(pk)` — which only
  // stops key-id collisions — lets a request authenticated just before the
  // deletion confirm mint a WORKING bearer credential into a partition the
  // teardown has already purged. Fencing here (rather than pre-checking) keeps
  // the credential and the fence in one atomic commit. The fence requires the
  // PROFILE row to exist as well as to be unflagged, so it covers the whole
  // window: `deleting = true` at confirm, and the purged-profile state after —
  // see the coverage note on orgNotDeletingCheck.
  try {
    await sendFencedWrite(orgId, [
      {
        Put: {
          TableName: Resource.UserInfoTable.name,
          Item: marshall({
            pk: RagApiKeyKeys.orgPk(orgId),
            sk: RagApiKeyKeys.orgSk(keyId),
            keyName,
            keyPrefix,
            tokenHash,
            bucketScope,
            ...(buckets ? { buckets } : {}),
            createdBy: userId,
            ...(creatorEmail ? { creatorEmail } : {}),
            createdAt,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: Resource.UserInfoTable.name,
          Item: marshall({
            pk: RagApiKeyKeys.lookupPk(tokenHash),
            sk: RagApiKeyKeys.lookupSk(),
            orgId,
            keyId,
            createdAt,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ]);
  } catch (err) {
    if (!(err instanceof OrgDeletingError)) throw err;
    console.warn('[create-rag-api-key] Refusing to mint a key: org deletion in progress', {
      orgId,
    });
    return accountDeletedResponse();
  }

  return new ResponseBuilder()
    .status(201)
    .body<CreateRagApiKeyResponse>({
      id: keyId,
      keyName,
      keyPrefix,
      token,
      bucketScope,
      ...(buckets ? { buckets } : {}),
      createdAt,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(ragAccessMiddleware())
  .use(errorHandlerMiddleware());
