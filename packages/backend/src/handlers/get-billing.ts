import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { convertToAttr, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import type Stripe from 'stripe';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { CachedStripePrice, SubscriptionRecord } from '../lib/dynamo-records.js';
import { TRIAL_DURATION_DAYS } from '@filone/shared/src/constants.js';

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
    return buildTrialResponse(billingRecord, userId, billingTableName);
  }

  // 3. Has Stripe customer — fetch subscription details (payment method + price)
  const stripeDetails = await resolveStripeSubscriptionDetails(
    billingRecord,
    userId,
    billingTableName,
  );

  // The billed price is unknown: Stripe is unreachable and we have nothing
  // cached. Fail loudly rather than understate what the customer pays.
  if (!stripeDetails) {
    return new ResponseBuilder()
      .status(502)
      .body<ErrorResponse>({ message: 'Unable to load billing details. Please try again.' })
      .build();
  }

  const currentStatus = await evaluateStatusTransitions(billingRecord, userId, billingTableName);

  const response = buildBillingResponse(billingRecord, currentStatus, stripeDetails);
  return new ResponseBuilder().status(200).body(response).build();
}

async function buildTrialResponse(
  billingRecord: SubscriptionRecord | null,
  userId: string,
  billingTableName: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const trialEndsAt =
    billingRecord?.trialEndsAt ??
    new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

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

interface StripeSubscriptionDetails {
  paymentMethod: BillingInfo['paymentMethod'];
  monthlyMinimumCents: number;
}

/**
 * Resolves the payment method and the billed price from Stripe. Returns null
 * when the Stripe call fails and no price snapshot is cached — the caller must
 * then fail the request instead of reporting an unknown minimum as "none".
 */
async function resolveStripeSubscriptionDetails(
  billingRecord: SubscriptionRecord,
  userId: string,
  billingTableName: string,
): Promise<StripeSubscriptionDetails | null> {
  let paymentMethod: BillingInfo['paymentMethod'];
  let price: CachedStripePrice | undefined;

  if (billingRecord.subscriptionId) {
    const stripe = getStripeClient();
    try {
      const subscription = await stripe.subscriptions.retrieve(billingRecord.subscriptionId, {
        // Tiers carry the monthly minimum and are not returned by default.
        expand: ['default_payment_method', 'items.data.price.tiers'],
      });

      paymentMethod = toPaymentMethod(subscription.default_payment_method);
      price = await resolveLivePrice(subscription, billingRecord, userId, billingTableName);
    } catch (err) {
      console.warn('[get-billing] Failed to fetch Stripe subscription', {
        error: (err as Error).message,
      });
      price = billingRecord.stripePrice;
      if (!price) {
        return null;
      }
    }
  }

  return {
    // Use cached payment method from DB if Stripe fetch didn't return one
    paymentMethod: paymentMethod ?? cachedPaymentMethod(billingRecord),
    monthlyMinimumCents: deriveMonthlyMinimumCents(price),
  };
}

function toPaymentMethod(
  pm: Stripe.Subscription['default_payment_method'],
): BillingInfo['paymentMethod'] {
  if (!pm || typeof pm !== 'object' || !pm.card) return undefined;
  return {
    id: pm.id,
    last4: pm.card.last4,
    brand: pm.card.brand,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

function cachedPaymentMethod(billingRecord: SubscriptionRecord): BillingInfo['paymentMethod'] {
  if (!billingRecord.paymentMethodLast4) return undefined;
  return {
    id: billingRecord.paymentMethodId ?? '',
    last4: billingRecord.paymentMethodLast4,
    brand: billingRecord.paymentMethodBrand ?? '',
    expMonth: billingRecord.paymentMethodExpMonth ?? 0,
    expYear: billingRecord.paymentMethodExpYear ?? 0,
  };
}

/** Returns the price the subscription is billed on, refreshing the cache when it changed. */
async function resolveLivePrice(
  subscription: Stripe.Subscription,
  billingRecord: SubscriptionRecord,
  userId: string,
  billingTableName: string,
): Promise<CachedStripePrice | undefined> {
  const livePrice = subscription.items?.data?.at(0)?.price;
  if (!livePrice) return undefined;

  const price = toCachedStripePrice(livePrice);
  if (price.id !== billingRecord.stripePrice?.id) {
    await cacheStripePrice(price, userId, billingTableName);
  }
  return price;
}

/**
 * The monthly minimum is the flat amount of the first tier on a graduated
 * tiered price. Grandfathered per-unit prices have no tiers, hence no minimum.
 * Volume tiering picks a single tier by total usage, so its first tier is not a
 * minimum either — report none rather than a wrong number.
 */
function deriveMonthlyMinimumCents(price: CachedStripePrice | undefined): number {
  if (price?.billing_scheme !== 'tiered' || price.tiers_mode !== 'graduated') return 0;
  const firstTier = price.tiers?.at(0);
  return amountToCents(firstTier?.flat_amount, firstTier?.flat_amount_decimal);
}

/**
 * Stripe returns every amount twice: `*_amount` in whole cents and
 * `*_amount_decimal` as an exact decimal string of cents. The decimal is the
 * authoritative one — sub-cent amounts round the integer field down, so our
 * $0.00499/GB rate arrives as `unit_amount: 0` next to `'0.499'`. Read the
 * decimal first, fall back to the integer, and round to whole cents.
 */
function amountToCents(
  amount: number | null | undefined,
  amountDecimal: string | null | undefined,
): number {
  if (amountDecimal != null) {
    const parsed = Number(amountDecimal);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return typeof amount === 'number' ? amount : 0;
}

/**
 * Keeps only the fields that are immutable on a Stripe price, so the cached
 * snapshot can never drift from Stripe. Mutable fields (`nickname`, `active`,
 * `metadata`, `lookup_key`) are dropped: we refresh the cache only when the
 * price id changes, which would leave any mutable value we stored stale.
 */
function toCachedStripePrice(price: Stripe.Price): CachedStripePrice {
  return {
    id: price.id,
    product: typeof price.product === 'string' ? price.product : price.product?.id,
    currency: price.currency,
    billing_scheme: price.billing_scheme,
    tiers_mode: price.tiers_mode,
    unit_amount: price.unit_amount,
    unit_amount_decimal: toDecimalString(price.unit_amount_decimal),
    ...(price.tiers
      ? {
          tiers: price.tiers.map((tier) => ({
            up_to: tier.up_to,
            flat_amount: tier.flat_amount,
            flat_amount_decimal: toDecimalString(tier.flat_amount_decimal),
            unit_amount: tier.unit_amount,
            unit_amount_decimal: toDecimalString(tier.unit_amount_decimal),
          })),
        }
      : {}),
    recurring: price.recurring
      ? {
          interval: price.recurring.interval,
          interval_count: price.recurring.interval_count,
          usage_type: price.recurring.usage_type,
          meter: price.recurring.meter,
        }
      : null,
  };
}

/** Stripe's `*_decimal` fields are decimal strings on the wire; keep them as strings. */
function toDecimalString(value: Stripe.Price['unit_amount_decimal']): string | null {
  return value == null ? null : String(value);
}

async function cacheStripePrice(
  price: CachedStripePrice,
  userId: string,
  billingTableName: string,
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: billingTableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression: 'SET stripePrice = :price, updatedAt = :now',
      ExpressionAttributeValues: {
        ':price': convertToAttr(price, { removeUndefinedValues: true }),
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

async function evaluateStatusTransitions(
  billingRecord: SubscriptionRecord,
  userId: string,
  billingTableName: string,
): Promise<SubscriptionStatus> {
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

  // Lazy eval: grace_period / past_due expired → report as canceled, but do NOT
  // persist the transition here. Persisting `canceled` from this read path flips
  // the record out of `grace_period` without disabling the tenant at the
  // orchestrator; since the grace-period-enforcer only scans `grace_period`, the
  // record would become invisible to the job that disables tenants, leaving
  // standing S3 access keys with data-plane access indefinitely. Leave the
  // record in `grace_period` so the enforcer owns the terminal cancel + tenant
  // disable; we only surface the canceled status in this response.
  if (
    (currentStatus === SubscriptionStatus.GracePeriod ||
      currentStatus === SubscriptionStatus.PastDue) &&
    billingRecord.gracePeriodEndsAt &&
    new Date(billingRecord.gracePeriodEndsAt).getTime() < Date.now()
  ) {
    currentStatus = SubscriptionStatus.Canceled;
  }

  return currentStatus;
}

function buildBillingResponse(
  billingRecord: SubscriptionRecord,
  currentStatus: SubscriptionStatus,
  { paymentMethod, monthlyMinimumCents }: StripeSubscriptionDetails,
): BillingInfo {
  const isActivePlan =
    currentStatus === SubscriptionStatus.Active ||
    currentStatus === SubscriptionStatus.PastDue ||
    currentStatus === SubscriptionStatus.GracePeriod;

  return {
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
      ...(monthlyMinimumCents > 0 ? { monthlyMinimumCents } : {}),
    },
    paymentMethod,
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
