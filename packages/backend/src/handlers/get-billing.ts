import { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus } from '@hyperspace/shared';
import type { BillingInfo, UsageInfo } from '@hyperspace/shared';
import { Resource } from "sst";
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = new DynamoDBClient({});

const TIB_BYTES = 1099511627776;
const PRICE_PER_TIB_CENTS = 499;
const TRIAL_STORAGE_LIMIT_BYTES = TIB_BYTES; // 1 TiB

async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyResultV2> {
  const { userId, email } = getUserInfo(event);
  const billingTableName = Resource.BillingTable.name;
  const uploadsTableName = Resource.UploadsTable.name;

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

  const billingRecord = billingResult.Item ? unmarshall(billingResult.Item) : null;

  // 2. Calculate usage from uploads table — sum sizeBytes of all objects
  let storageUsedBytes = 0;
  const bucketsResult = await dynamo.send(
    new QueryCommand({
      TableName: uploadsTableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':skPrefix': { S: 'BUCKET#' },
      },
    }),
  );

  const bucketNames = (bucketsResult.Items ?? []).map((item) => unmarshall(item).name as string);

  // Query objects for each bucket and sum sizes
  for (const bucketName of bucketNames) {
    const objectsResult = await dynamo.send(
      new QueryCommand({
        TableName: uploadsTableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${userId}#${bucketName}` },
          ':skPrefix': { S: 'OBJECT#' },
        },
        ProjectionExpression: 'sizeBytes',
      }),
    );

    for (const item of objectsResult.Items ?? []) {
      const record = unmarshall(item);
      storageUsedBytes += (record.sizeBytes as number) || 0;
    }
  }

  const estimatedMonthlyCostCents = Math.round((storageUsedBytes / TIB_BYTES) * PRICE_PER_TIB_CENTS);

  const usage: UsageInfo = {
    storageUsedBytes,
    storageLimitBytes: TRIAL_STORAGE_LIMIT_BYTES,
    estimatedMonthlyCostCents,
  };

  // 3. If no billing record → trial state
  if (!billingRecord || !billingRecord.stripeCustomerId) {
    const trialEndsAt = billingRecord?.trialEndsAt ??
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    // Lazy eval: if trialing and trial has expired → transition to grace_period
    if (billingRecord?.subscriptionStatus === SubscriptionStatus.Trialing
      && billingRecord.trialEndsAt
      && new Date(billingRecord.trialEndsAt as string).getTime() < Date.now()) {
      const gracePeriodEndsAt = new Date(
        new Date(billingRecord.trialEndsAt as string).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      await dynamo.send(
        new UpdateItemCommand({
          TableName: billingTableName,
          Key: {
            pk: { S: `CUSTOMER#${userId}` },
            sk: { S: 'SUBSCRIPTION' },
          },
          UpdateExpression: 'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
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
          trialEndsAt: billingRecord.trialEndsAt as string,
          gracePeriodEndsAt,
        },
        usage,
      };
      return new ResponseBuilder().status(200).body(response).build();
    }

    const response: BillingInfo = {
      subscription: {
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.Trialing,
        trialEndsAt,
      },
      usage,
    };

    return new ResponseBuilder().status(200).body(response).build();
  }

  // 4. Has Stripe customer — fetch subscription + payment method
  const stripe = getStripeClient();
  let paymentMethod: BillingInfo['paymentMethod'];

  if (billingRecord.subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(billingRecord.subscriptionId as string, {
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

      // Use unlimited storage for active subscribers
      usage.storageLimitBytes = -1;
    } catch (err) {
      console.warn('[get-billing] Failed to fetch Stripe subscription', { error: (err as Error).message });
    }
  }

  // Use cached payment method from DB if Stripe fetch didn't return one
  if (!paymentMethod && billingRecord.paymentMethodLast4) {
    paymentMethod = {
      id: billingRecord.paymentMethodId ?? '',
      last4: billingRecord.paymentMethodLast4 as string,
      brand: billingRecord.paymentMethodBrand as string,
      expMonth: billingRecord.paymentMethodExpMonth as number,
      expYear: billingRecord.paymentMethodExpYear as number,
    };
  }

  let currentStatus = billingRecord.subscriptionStatus as SubscriptionStatus;

  // Lazy eval: trial expired → grace_period
  if (currentStatus === SubscriptionStatus.Trialing
    && billingRecord.trialEndsAt
    && new Date(billingRecord.trialEndsAt as string).getTime() < Date.now()) {
    const gracePeriodEndsAt = new Date(
      new Date(billingRecord.trialEndsAt as string).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await dynamo.send(
      new UpdateItemCommand({
        TableName: billingTableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression: 'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
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
  if ((currentStatus === SubscriptionStatus.GracePeriod || currentStatus === SubscriptionStatus.PastDue)
    && billingRecord.gracePeriodEndsAt
    && new Date(billingRecord.gracePeriodEndsAt as string).getTime() < Date.now()) {
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

  const isActivePlan = currentStatus === SubscriptionStatus.Active
    || currentStatus === SubscriptionStatus.PastDue
    || currentStatus === SubscriptionStatus.GracePeriod;

  const response: BillingInfo = {
    subscription: {
      planId: isActivePlan ? PlanId.PayAsYouGo : (currentStatus === SubscriptionStatus.Trialing ? PlanId.FreeTrial : PlanId.PayAsYouGo),
      status: currentStatus,
      ...(currentStatus === SubscriptionStatus.Trialing && billingRecord.trialEndsAt ? { trialEndsAt: billingRecord.trialEndsAt as string } : {}),
      ...(billingRecord.trialEndsAt && currentStatus === SubscriptionStatus.GracePeriod ? { trialEndsAt: billingRecord.trialEndsAt as string } : {}),
      currentPeriodEnd: billingRecord.currentPeriodEnd as string | undefined,
      ...(billingRecord.canceledAt ? { canceledAt: billingRecord.canceledAt as string } : {}),
      ...(billingRecord.gracePeriodEndsAt ? { gracePeriodEndsAt: billingRecord.gracePeriodEndsAt as string } : {}),
    },
    paymentMethod,
    usage,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
