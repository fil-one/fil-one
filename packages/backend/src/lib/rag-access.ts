import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { Resource } from 'sst';
import { isFoundationEmail } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { ResponseBuilder } from './response-builder.js';
import type { AuthenticatedEvent } from './user-context.js';
import { getVerifiedEmail } from './user-context.js';

const dynamo = getDynamoClient();

/** DynamoDB sort key shared by every allowlist row. */
const ALLOWLIST_SK = 'ALLOWLIST';

/**
 * Whether `email` is on the per-email RAG allowlist stored in UserInfoTable.
 *
 * Reads a single row keyed `pk: ALLOWLIST#<lowercased-email>, sk: ALLOWLIST`
 * via a single GetItemCommand (mirrors org-profile.ts). The lookup is
 * case-insensitive: the email is lowercased before building the key. Presence
 * of the item is what grants access — attribute values are irrelevant.
 *
 * Onboarding a customer is a manual operation: put one item with
 * `pk = ALLOWLIST#<lowercased-email>` and `sk = ALLOWLIST` into UserInfoTable
 * (any attribute values are fine; the row's existence is the allowlist entry).
 * No redeploy is required.
 */
export async function isAllowlisted(email: string): Promise<boolean> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ALLOWLIST#${email.toLowerCase()}` }, sk: { S: ALLOWLIST_SK } },
    }),
  );
  return Item !== undefined;
}

/**
 * Compute the `ragAccess` flag for a verified email, resolving the allowlist
 * from DynamoDB only when needed. Returns `false` for unverified/missing
 * emails. Used by the getMe handler to expose the gate decision to the frontend.
 */
export async function hasRagAccess(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  if (isFoundationEmail(email)) return true;
  return isAllowlisted(email);
}

type GuardRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

/**
 * Middy middleware enforcing RAG access. Its `before` hook returns a 403
 * response to short-circuit the handler when the caller is not permitted, and
 * returns `undefined` (passes through) when access is granted — mirroring the
 * short-circuit convention used by subscriptionGuardMiddleware.
 *
 * Allowance is derived via {@link hasRagAccess} on the verified email
 * (verified-only — never the raw claim), so an unverified/missing email is
 * denied without crashing and without a DynamoDB lookup.
 *
 * Must run AFTER authMiddleware: it reads `requestContext.userInfo` from the
 * AuthenticatedEvent that the auth middleware populates.
 */
export function ragAccessMiddleware() {
  return {
    before: runRagAccessGuard,
  } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;
}

async function runRagAccessGuard(
  request: GuardRequest,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const event = request.event as AuthenticatedEvent;
  const allowed = await hasRagAccess(getVerifiedEmail(event));
  if (allowed) return undefined;
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({ message: 'You do not have access to this feature.' })
    .build();
}
