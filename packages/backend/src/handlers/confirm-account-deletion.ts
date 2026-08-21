import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, DeleteAccountSchema } from '@filone/shared';
import type { ConfirmAccountDeletionResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import {
  isSelfServeDeletionEnabled,
  selfServeDeletionUnavailable,
} from '../lib/account-deletion-flag.js';
import { invokeAccountDeletionWorker } from '../lib/account-deletion-invoke.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { deletionChallengeKey } from '../lib/deletion-challenge.js';
import {
  confirmAccountDeletion,
  consumeVerifyAttempt,
  type ConfirmResult,
} from '../lib/deletion-confirm-transaction.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

/**
 * Spends the emailed code and commits the deletion. Terminal: there is no undo,
 * no grace period and no cancel endpoint.
 *
 * Returns 202 — the account is already unusable when this returns, but the
 * upstream teardown runs afterwards.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!isSelfServeDeletionEnabled()) return selfServeDeletionUnavailable();

  const parsed = parseBody(event.body);
  if (!parsed.ok) return badRequest(parsed.message);

  const { orgId, userId } = getUserInfo(event);

  const orgProfile = await getOrgProfile(orgId, { consistent: true });
  if (orgProfile?.name?.S !== parsed.data.orgName) {
    return badRequest('The organization name does not match.');
  }

  // Read for its salt only; the code is verified inside the transaction, so two
  // concurrent confirms cannot both spend it.
  const salt = await readChallengeSalt(orgId);
  if (!salt) return codeResponse({ outcome: 'code_expired_or_locked' }, orgId);

  const result = await confirmAccountDeletion({
    orgId,
    requestedByUserId: userId,
    code: parsed.data.code,
    salt,
  });

  if (result.outcome !== 'confirmed' && result.outcome !== 'already_deleting') {
    return codeResponse(result, orgId);
  }

  console.log('[confirm-account-deletion] deletion recorded', {
    orgId,
    requestedByUserId: userId,
    alreadyRecorded: result.outcome === 'already_deleting',
  });

  // Fire-and-forget by design: it never throws, and the sweeper re-drives from
  // the record if it never lands.
  await invokeAccountDeletionWorker(orgId);

  return new ResponseBuilder()
    .status(202)
    .body<ConfirmAccountDeletionResponse>({
      message: 'Your organization and all its data are being deleted.',
    })
    .build();
}

function parseBody(
  body: string | undefined,
): { ok: true; data: { code: string; orgName: string } } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '{}');
  } catch {
    return { ok: false, message: 'Invalid JSON body' };
  }
  const parsed = DeleteAccountSchema.safeParse(json);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  return { ok: true, data: parsed.data };
}

async function readChallengeSalt(orgId: string): Promise<string | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.DeletionChallengeTable.name,
      Key: deletionChallengeKey(orgId),
      ProjectionExpression: 'salt',
      ConsistentRead: true,
    }),
  );
  return Item?.salt?.S;
}

async function codeResponse(
  result: ConfirmResult,
  orgId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Only a wrong code costs an attempt; an expired or locked one has nothing
  // left to spend.
  if (result.outcome === 'code_invalid') await consumeVerifyAttempt(orgId);

  const invalid = result.outcome === 'code_invalid';
  return new ResponseBuilder()
    .status(410)
    .body<ErrorResponse>({
      message: invalid
        ? 'That verification code is not valid.'
        : 'That verification code has expired or too many attempts were made. Request a new one.',
      code: invalid
        ? ApiErrorCode.DELETION_CODE_INVALID
        : ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
    })
    .build();
}

function badRequest(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // Before the MFA gate: a role the matrix refuses is denied outright, not
  // sent on a step-up round trip it would fail anyway.
  .use(authorize('org.delete'))
  .use(requireMfaIfEnrolled())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
