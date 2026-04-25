import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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
import { createBillingTrial } from '../lib/create-billing-trial.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';

export enum AccessLevel {
  Read = 'read',
  Write = 'write',
}

export interface GuardInternal extends Record<string, unknown> {
  billingTrialPromise?: Promise<void>;
}

type GuardRequest = Request<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context,
  GuardInternal
>;

const dynamo = getDynamoClient();

export function subscriptionGuardMiddleware(accessLevel: AccessLevel) {
  return {
    before: (request: GuardRequest) => runSubscriptionGuard(request, accessLevel),
    after: runSubscriptionGuardAfter,
  } satisfies MiddlewareObj<
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    Error,
    Context,
    GuardInternal
  >;
}

async function runSubscriptionGuard(
  request: GuardRequest,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const event = request.event as AuthenticatedEvent;
  const { userId, orgId, email } = getUserInfo(event);
  const tableName = Resource.BillingTable.name;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  // No billing record → allow access and attempt trial creation in background
  if (!result.Item) {
    request.internal.billingTrialPromise = createBillingTrial({ userId, orgId, email });
    return;
  }

  const record = unmarshall(result.Item);
  let status = record.subscriptionStatus as string | undefined;

  // No subscription status yet → allow
  if (!status) return;

  // Store the resolved status on the event so handlers can read it
  // without a second DynamoDB query (may be updated below by lazy transitions).
  event.requestContext.subscriptionStatus = status;

  if (status === SubscriptionStatus.Active) return;

  if (status === SubscriptionStatus.Trialing) {
    const transitioned = await transitionExpiredTrial(record, userId, tableName);
    if (!transitioned) return; // Trial still active
    status = transitioned;
    event.requestContext.subscriptionStatus = status;
  }

  if (status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue) {
    return handleGracePeriod(record, userId, tableName, accessLevel);
  }

  if (status === SubscriptionStatus.Canceled) {
    return buildCanceledResponse();
  }

  // Unknown or unhandled status → block (fail closed)
  return buildInactiveResponse();
}

async function runSubscriptionGuardAfter(request: GuardRequest): Promise<void> {
  if (request.internal.billingTrialPromise) {
    try {
      await request.internal.billingTrialPromise;
    } catch (error) {
      console.error(
        '[subscription-guard] Failed to create billing trial in subscription guard fallback:',
        error,
      );
    }
  }
}

/**
 * If the trial has expired, transition the record to grace_period and mutate
 * `record.gracePeriodEndsAt` in place so the caller can continue processing
 * as a grace-period record. Returns the new status, or null if still trialing.
 */
async function transitionExpiredTrial(
  record: Record<string, unknown>,
  userId: string,
  tableName: string,
): Promise<SubscriptionStatus.GracePeriod | null> {
  const trialEndsAt = record.trialEndsAt as string | undefined;
  if (!trialEndsAt || new Date(trialEndsAt).getTime() >= Date.now()) {
    return null;
  }

  // Lazy transition: trial expired → grace_period
  const gracePeriodEndsAt = addDays(new Date(trialEndsAt), TRIAL_GRACE_DAYS).toISOString();
  await dynamo.send(
    new UpdateItemCommand({
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
    }),
  );
  record.gracePeriodEndsAt = gracePeriodEndsAt;
  return SubscriptionStatus.GracePeriod;
}

async function handleGracePeriod(
  record: Record<string, unknown>,
  userId: string,
  tableName: string,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const gracePeriodEndsAt = record.gracePeriodEndsAt as string | undefined;
  if (gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < Date.now()) {
    // Lazy transition: grace expired → canceled
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :now',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.Canceled },
          ':now': { S: new Date().toISOString() },
        },
      }),
    );
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
