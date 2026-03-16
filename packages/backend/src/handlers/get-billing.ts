import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { SubscriptionRecord } from '../lib/dynamo-records.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId } = getUserInfo(event);
  const billingTableName = Resource.BillingTable.name;

  // 1. Get billing record
  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: billingTableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  const billingRecord = billingResult.Item
    ? (unmarshall(billingResult.Item) as SubscriptionRecord)
    : null;

  // 2. If no billing record → trial state
  if (!billingRecord || !billingRecord.stripeCustomerId) {
    const trialEndsAt =
      billingRecord?.trialEndsAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    // Lazy eval: if trialing and trial has expired → transition to grace_period
    if (
      billingRecord?.subscriptionStatus === SubscriptionStatus.Trialing &&
      billingRecord.trialEndsAt &&
      new Date(billingRecord.trialEndsAt).getTime() < Date.now()
    ) {
      const gracePeriodEndsAt = new Date(
        new Date(billingRecord.trialEndsAt).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      await dynamo.send(
        new UpdateItemCommand({
          TableName: billingTableName,
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

      const response: BillingInfo = {
        subscription: {
          planId: PlanId.FreeTrial,
          status: SubscriptionStatus.GracePeriod,
          trialEndsAt: billingRecord.trialEndsAt,
          gracePeriodEndsAt,
        },
      };
      return new ResponseBuilder().status(200).body(response).build();
    }

    const response: BillingInfo = {
      subscription: {
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.Trialing,
        trialEndsAt,
      },
    };

    return new ResponseBuilder().status(200).body(response).build();
  }

  // 3. Has Stripe customer — fetch subscription + payment method
  const stripe = getStripeClient();
  let paymentMethod: BillingInfo['paymentMethod'];

  if (billingRecord.subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(billingRecord.subscriptionId, {
        expand: ['default_payment_method'],
      });

      const pm = subscription.default_payment_method;
      if (pm && typeof pm === 'object' && pm.card) {
        paymentMethod = {
          id: pm.id,
          last4: pm.card.last4,
          brand: pm.card.brand,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        };
      }
    } catch (err) {
      console.warn('[get-billing] Failed to fetch Stripe subscription', {
        error: (err as Error).message,
      });
    }
  }

  // Use cached payment method from DB if Stripe fetch didn't return one
  if (!paymentMethod && billingRecord.paymentMethodLast4) {
    paymentMethod = {
      id: billingRecord.paymentMethodId ?? '',
      last4: billingRecord.paymentMethodLast4,
      brand: billingRecord.paymentMethodBrand ?? '',
      expMonth: billingRecord.paymentMethodExpMonth ?? 0,
      expYear: billingRecord.paymentMethodExpYear ?? 0,
    };
  }

  let currentStatus = billingRecord.subscriptionStatus ?? SubscriptionStatus.Trialing;

  // Lazy eval: trial expired → grace_period
  if (
    currentStatus === SubscriptionStatus.Trialing &&
    billingRecord.trialEndsAt &&
    new Date(billingRecord.trialEndsAt).getTime() < Date.now()
  ) {
    const gracePeriodEndsAt = new Date(
      new Date(billingRecord.trialEndsAt).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await dynamo.send(
      new UpdateItemCommand({
        TableName: billingTableName,
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
    currentStatus = SubscriptionStatus.GracePeriod;
    billingRecord.gracePeriodEndsAt = gracePeriodEndsAt;
  }

  // Lazy eval: grace_period / past_due expired → canceled
  if (
    (currentStatus === SubscriptionStatus.GracePeriod ||
      currentStatus === SubscriptionStatus.PastDue) &&
    billingRecord.gracePeriodEndsAt &&
    new Date(billingRecord.gracePeriodEndsAt).getTime() < Date.now()
  ) {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: billingTableName,
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
    currentStatus = SubscriptionStatus.Canceled;
  }

  const isActivePlan =
    currentStatus === SubscriptionStatus.Active ||
    currentStatus === SubscriptionStatus.PastDue ||
    currentStatus === SubscriptionStatus.GracePeriod;

  const response: BillingInfo = {
    subscription: {
      planId: isActivePlan
        ? PlanId.PayAsYouGo
        : currentStatus === SubscriptionStatus.Trialing
          ? PlanId.FreeTrial
          : PlanId.PayAsYouGo,
      status: currentStatus,
      ...(currentStatus === SubscriptionStatus.Trialing && billingRecord.trialEndsAt
        ? { trialEndsAt: billingRecord.trialEndsAt }
        : {}),
      ...(billingRecord.trialEndsAt && currentStatus === SubscriptionStatus.GracePeriod
        ? { trialEndsAt: billingRecord.trialEndsAt }
        : {}),
      currentPeriodEnd: billingRecord.currentPeriodEnd,
      ...(billingRecord.canceledAt ? { canceledAt: billingRecord.canceledAt } : {}),
      ...(billingRecord.gracePeriodEndsAt
        ? { gracePeriodEndsAt: billingRecord.gracePeriodEndsAt }
        : {}),
    },
    paymentMethod,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
