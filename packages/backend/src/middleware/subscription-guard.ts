import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ApiErrorCode, SubscriptionStatus } from '@filone/shared';
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

const TRIAL_GRACE_DAYS = 7;
const _PAID_GRACE_DAYS = 30;

const dynamo = getDynamoClient();

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function subscriptionGuardMiddleware(accessLevel: AccessLevel) {
  const before = async (
    request: Request<
      APIGatewayProxyEventV2,
      APIGatewayProxyResultV2,
      Error,
      Context,
      GuardInternal
    >,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const event = request.event as AuthenticatedEvent;
    const { userId, orgId, email } = getUserInfo(event);
    const tableName = Resource.BillingTable.name;

    // 1. Read billing record
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
      }),
    );

    // 2. No billing record → allow access and attempt trial creation in background
    if (!result.Item) {
      request.internal.billingTrialPromise = createBillingTrial({ userId, orgId, email });
      return;
    }

    const record = unmarshall(result.Item);
    let status = record.subscriptionStatus as string | undefined;

    // No subscription status yet → allow
    if (!status) return;

    // 3. Active → allow
    if (status === SubscriptionStatus.Active) return;

    // 4. Trialing
    if (status === SubscriptionStatus.Trialing) {
      const trialEndsAt = record.trialEndsAt as string | undefined;
      if (trialEndsAt && new Date(trialEndsAt).getTime() < Date.now()) {
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
        status = SubscriptionStatus.GracePeriod;
        // Fall through to grace_period handling below
      } else {
        return; // Trial still active
      }
    }

    // 5. Grace period or past due
    if (status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue) {
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
        return new ResponseBuilder()
          .status(403)
          .body({
            message: 'Your subscription has been canceled. Please reactivate to regain access.',
            code: ApiErrorCode.SUBSCRIPTION_CANCELED,
          })
          .build();
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

      // Read access → allow
      return;
    }

    // 6. Canceled → block
    if (status === SubscriptionStatus.Canceled) {
      return new ResponseBuilder()
        .status(403)
        .body({
          message: 'Your subscription has been canceled. Please reactivate to regain access.',
          code: ApiErrorCode.SUBSCRIPTION_CANCELED,
        })
        .build();
    }

    // Unknown status → allow (fail open for safety)
  };

  const after = async (
    request: Request<
      APIGatewayProxyEventV2,
      APIGatewayProxyResultV2,
      Error,
      Context,
      GuardInternal
    >,
  ): Promise<void> => {
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
  };

  return { before, after } satisfies MiddlewareObj<
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    Error,
    Context,
    GuardInternal
  >;
}
