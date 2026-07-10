import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DeleteAccountResponse, ErrorResponse } from '@filone/shared';
import { ApiErrorCode, CSRF_COOKIE_NAME, DeleteAccountSchema, OrgRole } from '@filone/shared';
import { Resource } from 'sst';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { parseCookies } from '../lib/cookies.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { verifyDeletionChallenge } from '../lib/deletion-challenge.js';
import {
  DeletionKeys,
  OrgDeletionStatus,
  type OrgDeletionMember,
  type OrgDeletionRecord,
} from '../lib/dynamo-records.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { COOKIE_NAMES, makeClearAuthCookies, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';
import type { AccountDeletionWorkerPayload } from '../jobs/account-deletion-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

/**
 * Confirm account deletion (FIL-112). Validates the typed org name and the
 * emailed verification code, snapshots everything the async teardown worker
 * needs, kills every member session, and responds success immediately — the
 * worker (plus the reconciler cron) finishes the teardown in the background.
 * No subscription guard: grace/canceled users must still be able to delete.
 */
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId } = getUserInfo(event);

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }
  const parsed = DeleteAccountSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, parsed.error.issues[0].message);
  }

  // Server-side type-to-confirm: the client gate alone is not trusted.
  const orgProfile = await getOrgProfile(orgId);
  const orgName = orgProfile?.name?.S?.trim() ?? '';
  if (parsed.data.orgName.trim() !== orgName || orgName === '') {
    return errorResponse(400, 'Organization name does not match');
  }

  const memberRow = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: `MEMBER#${userId}` }),
    }),
  );
  if (memberRow.Item?.role?.S !== OrgRole.Admin) {
    return errorResponse(403, 'Only an organization admin can delete the account');
  }

  const verify = await verifyDeletionChallenge(orgId, parsed.data.code);
  if (verify === 'invalid') {
    return errorResponse(400, 'Incorrect verification code', ApiErrorCode.DELETION_CODE_INVALID);
  }
  if (verify === 'expired_or_locked') {
    return errorResponse(
      410,
      'Verification code expired or locked — request a new one',
      ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
    );
  }

  const members = await snapshotMembers(orgId);
  const billing = await snapshotBilling(members);

  const record: OrgDeletionRecord = {
    pk: DeletionKeys.deletionPk(orgId),
    sk: DeletionKeys.deletionSk(),
    status: OrgDeletionStatus.Pending,
    requestedAt: new Date().toISOString(),
    requestedByUserId: userId,
    members,
    ...(orgProfile?.auroraTenantId?.S ? { auroraTenantId: orgProfile.auroraTenantId.S } : {}),
    ...(orgProfile?.fthTenantId?.S ? { fthTenantId: orgProfile.fthTenantId.S } : {}),
    ...billing,
    attemptCount: 0,
    updatedAt: new Date().toISOString(),
  };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.UserInfoTable.name,
        Item: marshall(record),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    // Deletion already confirmed earlier — idempotent re-confirm. The fences
    // below re-apply harmlessly and the worker invoke resumes the teardown.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  await applyFences(orgId, members);

  await revokeRefreshToken(event);
  await invokeWorker(orgId);

  return successResponse();
}

/** MEMBER# rows → {userId, sub} pairs (sub resolved via USER#/PROFILE). */
async function snapshotMembers(orgId: string): Promise<OrgDeletionMember[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :member)',
      ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}`, ':member': 'MEMBER#' }),
    }),
  );
  const userIds = (result.Items ?? []).map((item) => item.sk!.S!.slice('MEMBER#'.length));

  const members: OrgDeletionMember[] = [];
  for (const memberUserId of userIds) {
    const profile = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `USER#${memberUserId}`, sk: 'PROFILE' }),
      }),
    );
    const sub = profile.Item?.sub?.S;
    members.push({ userId: memberUserId, ...(sub ? { sub } : {}) });
  }
  return members;
}

/** First member billing record with Stripe references wins (one per org). */
async function snapshotBilling(
  members: OrgDeletionMember[],
): Promise<Pick<OrgDeletionRecord, 'stripeCustomerId' | 'subscriptionId'>> {
  for (const member of members) {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.BillingTable.name,
        Key: marshall({ pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' }),
      }),
    );
    if (Item?.stripeCustomerId?.S || Item?.subscriptionId?.S) {
      return {
        ...(Item.stripeCustomerId?.S ? { stripeCustomerId: Item.stripeCustomerId.S } : {}),
        ...(Item.subscriptionId?.S ? { subscriptionId: Item.subscriptionId.S } : {}),
      };
    }
  }
  return {};
}

/**
 * The synchronous, security-critical writes: fence Stripe webhooks and the
 * grace-period enforcer off the billing record, block tenant setup on the
 * profile, and tombstone every member identity so all sessions die on their
 * very next request — before the 200 is returned.
 */
async function applyFences(orgId: string, members: OrgDeletionMember[]): Promise<void> {
  const now = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
        UpdateExpression: 'SET deleting = :true',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: marshall({ ':true': true }),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Profile already purged by a running teardown — nothing to fence.
  }

  for (const member of members) {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: marshall({ pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' }),
          UpdateExpression: 'SET deletionRequestedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: marshall({ ':now': now }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // No billing record (e.g. trial never started) — nothing to fence.
    }

    if (member.sub) {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.UserInfoTable.name,
          Key: marshall({ pk: `SUB#${member.sub}`, sk: 'IDENTITY' }),
          UpdateExpression: 'SET deleted = :true, deletedAt = :now',
          ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
        }),
      );
    }
  }
}

/**
 * Best-effort revocation of this session's refresh token at Auth0 (same as
 * logout). The worker deletes the Auth0 user shortly after, which invalidates
 * every other device's refresh token too.
 */
async function revokeRefreshToken(event: AuthenticatedEvent): Promise<void> {
  const refreshToken = parseCookies(event.cookies)[COOKIE_NAMES.REFRESH_TOKEN];
  if (!refreshToken) return;
  const secrets = getAuthSecrets();
  try {
    await fetch(`https://${process.env.AUTH0_DOMAIN!}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: secrets.AUTH0_CLIENT_ID,
        client_secret: secrets.AUTH0_CLIENT_SECRET,
        token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    console.warn('[delete-account] Refresh token revocation failed', { error: err });
  }
}

async function invokeWorker(orgId: string): Promise<void> {
  const payload: AccountDeletionWorkerPayload = { orgId };
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

function errorResponse(
  status: number,
  message: string,
  code?: ApiErrorCode,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(status)
    .body<ErrorResponse>({ message, ...(code ? { code } : {}) })
    .build();
}

function successResponse(): APIGatewayProxyStructuredResultV2 {
  const builder = new ResponseBuilder()
    .status(200)
    .body<DeleteAccountResponse>({ message: 'Account deleted' });
  for (const cookie of makeClearAuthCookies(CSRF_COOKIE_NAME)) {
    builder.addCookie(cookie);
  }
  return builder.build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(requireMfaIfEnrolled())
  .use(errorHandlerMiddleware());
