import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { convertToAttr, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import type Stripe from 'stripe';
import { getDynamoClient } from '../lib/ddb-client.js';
import { sendGuardedBillingUpdate } from '../lib/deletion-guards.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { StripePriceDetails, SubscriptionRecord } from '../lib/dynamo-records.js';

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

  // 2. No record, or a record without a status (e.g. the customer mapping
  // written by create-setup-intent) → not entitled. This read model must report
  // the same truth as the subscription guard, never synthesize a trial;
  // entitlement is granted only by ensureTrialEntitlement.
  const storedStatus = billingRecord?.subscriptionStatus;
  if (!billingRecord || !storedStatus) {
    return inactiveResponse(billingRecord);
  }

  // 3. Status but no Stripe customer (webhook-born or legacy records) → report
  // the stored status; there is no customer to look up, so no Stripe call.
  // The minimum still comes from the cached price snapshot when the record
  // carries one — the same source the Stripe-unreachable path reads. Only a
  // record with no snapshot at all reports no minimum, and that is factual:
  // with no Stripe customer there is no subscription to bill a minimum on.
  if (!billingRecord.stripeCustomerId) {
    const currentStatus = await evaluateStatusTransitions(
      billingRecord,
      storedStatus,
      userId,
      billingTableName,
    );
    const response = buildBillingResponse(billingRecord, currentStatus, {
      paymentMethod: cachedPaymentMethod(billingRecord),
      monthlyMinimumCents: deriveMonthlyMinimumCents(billingRecord.stripePrice),
    });
    return new ResponseBuilder().status(200).body(response).build();
  }

  // 4. Has Stripe customer — fetch subscription details (payment method + price)
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

  const currentStatus = await evaluateStatusTransitions(
    billingRecord,
    storedStatus,
    userId,
    billingTableName,
  );

  const response = buildBillingResponse(billingRecord, currentStatus, stripeDetails);
  return new ResponseBuilder().status(200).body(response).build();
}

/**
 * The account holds no entitlement: no billing record, or a record with no
 * subscription status. Reports `planId: none, status: inactive` — the read
 * counterpart of the guard's SUBSCRIPTION_INACTIVE 403. Deliberately no
 * `trialEndsAt` (there is no trial to promise a date for), no Stripe call, and
 * no DynamoDB write. A cached card is still reported so the console can offer
 * it once the user picks a plan.
 */
function inactiveResponse(
  billingRecord: SubscriptionRecord | null,
): APIGatewayProxyStructuredResultV2 {
  const response: BillingInfo = {
    subscription: {
      planId: PlanId.None,
      status: SubscriptionStatus.Inactive,
    },
    ...(billingRecord ? { paymentMethod: cachedPaymentMethod(billingRecord) } : {}),
  };
  return new ResponseBuilder().status(200).body(response).build();
}

interface StripeSubscriptionDetails {
  paymentMethod: BillingInfo['paymentMethod'];
  monthlyMinimumCents: number | undefined;
}

// Stripe SDK errors expose `code` on the error object; matches StripeInvalidRequestError 404s.
const isStripeResourceMissing = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'resource_missing';

/**
 * Resolves the payment method and the billed price from Stripe. Returns null
 * when the Stripe call fails and no price snapshot is cached — the caller must
 * then fail the request instead of reporting an unknown minimum as "none".
 *
 * A `resource_missing` error is the exception: the subscription is gone from
 * Stripe, so there is no minimum left to understate. Report none and let the
 * caller serve the status we hold in DynamoDB — the customer still needs the
 * dashboard to tell them their payment failed.
 */
async function resolveStripeSubscriptionDetails(
  billingRecord: SubscriptionRecord,
  userId: string,
  billingTableName: string,
): Promise<StripeSubscriptionDetails | null> {
  let paymentMethod: BillingInfo['paymentMethod'];
  let price: StripePriceDetails | undefined;

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
      if (!price && !isStripeResourceMissing(err)) {
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
): Promise<StripePriceDetails | undefined> {
  const livePrice = subscription.items?.data?.at(0)?.price;
  if (!livePrice) return undefined;

  const price = toStripePriceDetails(livePrice);
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
 *
 * A graduated price always has tiers, so an empty list means we lost them (a
 * dropped `expand` or a snapshot cached without them). Throw: reporting "no
 * minimum" would understate what the customer pays.
 */
function deriveMonthlyMinimumCents(price: StripePriceDetails | undefined): number | undefined {
  if (price?.billing_scheme !== 'tiered' || price.tiers_mode !== 'graduated') return undefined;
  const firstTier = price.tiers?.at(0);
  if (!firstTier) {
    throw new Error(`Graduated price ${price.id} has no tiers to read the monthly minimum from`);
  }
  return amountToCents(firstTier.flat_amount, firstTier.flat_amount_decimal);
}

/**
 * Stripe returns every amount twice: `*_amount` in whole cents and
 * `*_amount_decimal` as an exact decimal string of cents. The decimal is the
 * authoritative one — sub-cent amounts round the integer field down, so our
 * $0.00499/GB rate arrives as `unit_amount: 0` next to `'0.499'`. Read the
 * decimal first, fall back to the integer, and round to whole cents. Both
 * fields are null when the amount does not apply at all (a tier with no flat
 * fee); return undefined so callers can tell that apart from a zero amount. A
 * decimal we cannot parse is never silently swapped for the rounded integer —
 * throw, because the integer may be a sub-cent amount rounded to zero.
 */
function amountToCents(
  amount: number | null | undefined,
  amountDecimal: string | null | undefined,
): number | undefined {
  if (amountDecimal != null) {
    const parsed = Number(amountDecimal);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Stripe amount decimal is not a number: ${JSON.stringify(amountDecimal)}`);
    }
    return Math.round(parsed);
  }
  return amount ?? undefined;
}

/**
 * Keeps only the fields that are immutable on a Stripe price, so the cached
 * snapshot can never drift from Stripe. Mutable fields (`nickname`, `active`,
 * `metadata`, `lookup_key`) are dropped: we refresh the cache only when the
 * price id changes, which would leave any mutable value we stored stale.
 */
function toStripePriceDetails(price: Stripe.Price): StripePriceDetails {
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

/**
 * Refreshes the cached price snapshot. Deletion-guarded (FIL-112): the write is
 * upsert-capable and follows a Stripe round-trip, so the read-then-write window
 * is wide enough for the account teardown's purge to land in between —
 * unconditioned, this cache write would resurrect the billing record it just
 * deleted. A guard rejection only costs a stale cache entry for a record that is
 * on its way out, so it is a skip, not an error.
 */
async function cacheStripePrice(
  price: StripePriceDetails,
  userId: string,
  billingTableName: string,
): Promise<void> {
  await sendGuardedBillingUpdate(
    {
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
    },
    { source: 'get-billing.cacheStripePrice', userId },
  );
}

async function evaluateStatusTransitions(
  billingRecord: SubscriptionRecord,
  storedStatus: SubscriptionStatus,
  userId: string,
  billingTableName: string,
): Promise<SubscriptionStatus> {
  let currentStatus = storedStatus;

  // Lazy eval: trial expired → grace_period
  if (
    currentStatus === SubscriptionStatus.Trialing &&
    billingRecord.trialEndsAt &&
    new Date(billingRecord.trialEndsAt).getTime() < Date.now()
  ) {
    const gracePeriodEndsAt = new Date(
      new Date(billingRecord.trialEndsAt).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Deletion-guarded (FIL-112): same upsert-capable lazy transition as
    // middleware/subscription-guard.ts. A guard rejection is a skip — the
    // response still reports grace_period, which is the read model this record
    // has already earned; only the persistence is declined.
    await sendGuardedBillingUpdate(
      {
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
      },
      { source: 'get-billing.evaluateStatusTransitions', userId },
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
      ...(monthlyMinimumCents ? { monthlyMinimumCents } : {}),
    },
    paymentMethod,
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
