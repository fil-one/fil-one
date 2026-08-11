import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ApiErrorCode, SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { sendGuardedBillingUpdate } from '../lib/deletion-guards.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { ensureTrialEntitlement } from '../lib/trial-entitlement.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';

export enum AccessLevel {
  Read = 'read',
  Write = 'write',
}

type GuardRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

const dynamo = getDynamoClient();

export function subscriptionGuardMiddleware(accessLevel: AccessLevel) {
  return {
    before: (request: GuardRequest) => runSubscriptionGuard(request, accessLevel),
  } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;
}

async function runSubscriptionGuard(
  request: GuardRequest,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const event = request.event as AuthenticatedEvent;
  const { sub, userId, orgId, email, emailVerified } = getUserInfo(event);
  const tableName = Resource.BillingTable.name;

  // Consistent read so a trial just written by the auth middleware (same request)
  // is visible — otherwise a stale read could falsely block an entitled user.
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      ConsistentRead: true,
    }),
  );

  // No billing record → only entitled (verified, claim-owning) users get a trial.
  if (!result.Item) {
    const entitled = await ensureTrialEntitlement({
      sub,
      userId,
      orgId,
      email: email ?? null,
      emailVerified,
    });
    return entitled ? undefined : buildInactiveResponse();
  }

  const record = unmarshall(result.Item);
  let status = record.subscriptionStatus as string | undefined;

  // No subscription status → no entitlement
  // A record can exist without a status
  if (!status) return buildInactiveResponse();

  // Store the resolved status on the event so handlers can read it
  // without a second DynamoDB query (may be updated below by lazy transitions).
  event.requestContext.subscriptionStatus = status;

  if (status === SubscriptionStatus.Active) return;

  if (status === SubscriptionStatus.Trialing) {
    const transitioned = await transitionExpiredTrial(record, userId, tableName);
    if (transitioned === 'still-trialing') return; // Trial still active
    if (transitioned === 'declined') return buildInactiveResponse();
    status = transitioned;
    event.requestContext.subscriptionStatus = status;
  }

  if (status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue) {
    return handleGracePeriod(record, accessLevel);
  }

  if (status === SubscriptionStatus.Canceled) {
    return buildCanceledResponse();
  }

  // Inactive is a read-model value (never persisted), but if it ever reaches a
  // record, blocking is the stated contract — not an accident of fail-closed.
  if (status === SubscriptionStatus.Inactive) {
    return buildInactiveResponse();
  }

  // Unknown or unhandled status → block (fail closed)
  return buildInactiveResponse();
}

/**
 * Outcome of the lazy trial→grace transition: the trial is still running, the
 * record moved to grace_period, or the deletion guard refused the write.
 */
type TrialTransition = SubscriptionStatus.GracePeriod | 'still-trialing' | 'declined';

/**
 * If the trial has expired, transition the record to grace_period and mutate
 * `record.gracePeriodEndsAt` in place so the caller can continue processing
 * as a grace-period record.
 *
 * The write is deletion-guarded (FIL-112): this update is upsert-capable and
 * runs on effectively every guarded request, so unconditioned it would
 * re-create a billing record the account teardown just purged.
 *
 * A rejection returns `'declined'` and the caller must block the request
 * outright — it must NOT fall through on the in-memory grace_period. Promoting
 * `trialing → grace_period` in memory is not uniformly more restrictive:
 * `handlers/presign.ts` blocks shareable presigned getObject URLs for
 * `trialing` only, so continuing on grace_period would hand a time-limited
 * public URL to bucket data — one that outlives the request — to an account
 * mid-deletion. The record existed at the ConsistentRead milliseconds earlier
 * and only the teardown and `deleted-customer-cleanup` can remove it or set
 * `deletionRequestedAt`, so a rejection here is an unambiguous deletion signal
 * with no false-positive cost.
 */
async function transitionExpiredTrial(
  record: Record<string, unknown>,
  userId: string,
  tableName: string,
): Promise<TrialTransition> {
  const trialEndsAt = record.trialEndsAt as string | undefined;
  if (!trialEndsAt || new Date(trialEndsAt).getTime() >= Date.now()) {
    return 'still-trialing';
  }

  // Lazy transition: trial expired → grace_period
  const gracePeriodEndsAt = addDays(new Date(trialEndsAt), TRIAL_GRACE_DAYS).toISOString();
  const persisted = await sendGuardedBillingUpdate({
    TableName: tableName,
    Key: {
      pk: { S: `CUSTOMER#${userId}` },
      sk: { S: 'SUBSCRIPTION' },
    },
    UpdateExpression:
      'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
    ExpressionAttributeValues: {
      ':status': { S: SubscriptionStatus.GracePeriod },
      ':grace': { S: gracePeriodEndsAt },
      ':now': { S: new Date().toISOString() },
    },
  });
  if (!persisted) return 'declined';

  record.gracePeriodEndsAt = gracePeriodEndsAt;
  return SubscriptionStatus.GracePeriod;
}

async function handleGracePeriod(
  record: Record<string, unknown>,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const gracePeriodEndsAt = record.gracePeriodEndsAt as string | undefined;
  if (gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < Date.now()) {
    // Grace expired → respond as canceled, but do NOT persist the transition
    // here. Persisting `canceled` from this read/hot path flips the record out
    // of `grace_period` without disabling the tenant at the orchestrator — and
    // the grace-period-enforcer only scans `grace_period`, so the record would
    // become invisible to the one job that disables tenants, leaving standing
    // S3 access keys with data-plane access indefinitely. Leave the record in
    // `grace_period` so the enforcer owns the terminal cancel + tenant disable.
    return buildCanceledResponse();
  }

  if (accessLevel === AccessLevel.Write) {
    return new ResponseBuilder()
      .status(403)
      .body({
        message:
          'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
        code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
      })
      .build();
  }

  // Read access within grace period → allow
  return;
}

function buildCanceledResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    })
    .build();
}

function buildInactiveResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    })
    .build();
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
