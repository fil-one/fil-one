import { convertToAttr } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, PlanId, SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import type { BillingInfo, ErrorResponse } from '@filone/shared';
import type Stripe from 'stripe';
import { getStripeClient } from '../lib/stripe-client.js';
import {
  readSubscription,
  updateSubscription,
  type SubscriptionOwner,
} from '../lib/subscription-store.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { claimTrialIfEligible, isTrialClaimable } from '../lib/trial-claim.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { StripePriceDetails, SubscriptionRecord } from '../lib/dynamo-records.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const userInfo = getUserInfo(event);
  const { userId, orgId } = userInfo;
  const owner: SubscriptionOwner = { orgId, userId };

  // 1. Get the org's billing record — every member sees the org's plan and
  // status, which is what riding the org's subscription means.
  let billingRecord = (await readSubscription(orgId)) ?? null;

  // 2. This is the dashboard's first call and no subscription guard sits in
  // front of it, so it is where an organic signup's trial gets claimed. Without
  // this the account would read as inactive until the user happened to touch a
  // gated route. Same eligibility test as the guard's, one implementation, and
  // it writes only when the claim is genuinely open.
  if (isTrialClaimable(billingRecord ?? undefined)) {
    const outcome = await claimTrialIfEligible(userInfo);
    if (outcome === 'claimed') {
      billingRecord = (await readSubscription(orgId, { consistentRead: true })) ?? null;
    } else if (outcome === 'legacy-row') {
      // The claim refused because a pre-re-key `CUSTOMER#` row is still
      // standing: this account has billing the org key cannot see. Reporting
      // "no plan" would be a lie the dashboard invites the user to act on, so
      // the honest answer is that the state cannot be read right now.
      return billingUnavailableResponse();
    }
  }

  // 3. No record, or a record without a status (e.g. the customer mapping
  // written by create-setup-intent, for a caller who cannot claim a trial) →
  // not entitled. This read model reports the same truth as the subscription
  // guard; entitlement itself is granted only by ensureTrialEntitlement.
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
    const currentStatus = await evaluateStatusTransitions(billingRecord, storedStatus, owner);
    const response = buildBillingResponse(billingRecord, currentStatus, {
      paymentMethod: cachedPaymentMethod(billingRecord),
      ...describePrice(billingRecord.stripePrice),
    });
    return new ResponseBuilder().status(200).body(response).build();
  }

  // 4. Has Stripe customer — fetch subscription details (payment method + price)
  const stripeDetails = await resolveStripeSubscriptionDetails(billingRecord, owner);

  // The billed price is unknown: Stripe is unreachable and we have nothing
  // cached. Fail loudly rather than understate what the customer pays.
  if (!stripeDetails) {
    return new ResponseBuilder()
      .status(502)
      .body<ErrorResponse>({ message: 'Unable to load billing details. Please try again.' })
      .build();
  }

  const currentStatus = await evaluateStatusTransitions(billingRecord, storedStatus, owner);

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
/**
 * The account's billing exists somewhere this route cannot read, so its state is
 * unknown rather than absent.
 *
 * Same status and code as the subscription guard's refusal, because it is the
 * same condition seen from the read side: the console shows "unable to load
 * billing details" and offers no plan actions, instead of a "no plan" panel that
 * would invite the user to buy a second subscription.
 */
function billingUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({
      message: 'Unable to load billing details for this account. Please try again shortly.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    })
    .build();
}

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
  /** The Stripe product's name, when the price carries one. */
  planName: string | undefined;
  /** The per-TB monthly rate, when the price states one unambiguously. */
  pricePerTbCents: number | undefined;
}

/** Everything the response says about the billed price, from one snapshot. */
function describePrice(price: StripePriceDetails | undefined): {
  monthlyMinimumCents: number | undefined;
  planName: string | undefined;
  pricePerTbCents: number | undefined;
} {
  return {
    monthlyMinimumCents: deriveMonthlyMinimumCents(price),
    planName: price?.product_name,
    pricePerTbCents: derivePricePerTbCents(price),
  };
}

/**
 * The usage rate per TB per month, in cents, when the price states one and only
 * one.
 *
 * Stripe meters this product in GB, so a TB is 1000 of its units. Two shapes
 * give a single honest answer: a per-unit price, and a graduated price whose
 * usage tiers all carry the same unit rate (self-serve's shape, where the first
 * tier is a flat minimum and everything above it is charged at one rate).
 * Anything else — volume tiering, graduated tiers that step — has no single
 * rate, and returns undefined rather than the first one it finds.
 */
function derivePricePerTbCents(price: StripePriceDetails | undefined): number | undefined {
  if (!price) return undefined;

  if (price.billing_scheme === 'per_unit') {
    return perTbCents(price.unit_amount, price.unit_amount_decimal);
  }

  if (price.billing_scheme !== 'tiered' || price.tiers_mode !== 'graduated') return undefined;

  // The tiers that charge for usage, which is every tier carrying a rate above
  // zero. The first tier of the self-serve price is the flat minimum at a zero
  // rate, so it drops out here and the rate comes from the tiers above it.
  const rates = (price.tiers ?? [])
    .map((tier) => perTbCents(tier.unit_amount, tier.unit_amount_decimal))
    .filter((rate): rate is number => rate !== undefined && rate > 0);
  if (rates.length === 0) return undefined;

  const [first] = rates;
  return rates.every((rate) => rate === first) ? first : undefined;
}

/** Stripe meters this product per GB, and pricing is quoted per TB. */
const GB_PER_TB = 1000;

/**
 * A per-GB Stripe amount as whole cents per TB.
 *
 * Scaled before rounding, which is the whole point of doing this here rather
 * than through `amountToCents`: the self-serve rate is $0.00499 per GB, so
 * rounding per GB first turns 0.499 cents into nothing and reports a plan as
 * free. Multiplied first, it is 499 cents per TB, exactly what the price says.
 */
function perTbCents(
  amount: number | null | undefined,
  amountDecimal: string | null | undefined,
): number | undefined {
  if (amountDecimal != null) {
    const parsed = Number(amountDecimal);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Stripe amount decimal is not a number: ${JSON.stringify(amountDecimal)}`);
    }
    return Math.round(parsed * GB_PER_TB);
  }
  return amount == null ? undefined : amount * GB_PER_TB;
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
  owner: SubscriptionOwner,
): Promise<StripeSubscriptionDetails | null> {
  let paymentMethod: BillingInfo['paymentMethod'];
  let price: StripePriceDetails | undefined;

  if (billingRecord.subscriptionId) {
    const stripe = getStripeClient();
    try {
      const subscription = await stripe.subscriptions.retrieve(billingRecord.subscriptionId, {
        // Tiers carry the monthly minimum and are not returned by default, and
        // the product carries the name of the plan the customer is on.
        expand: ['default_payment_method', 'items.data.price.tiers', 'items.data.price.product'],
      });

      paymentMethod = toPaymentMethod(subscription.default_payment_method);
      price = await resolveLivePrice(subscription, billingRecord, owner);
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
    ...describePrice(price),
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
  owner: SubscriptionOwner,
): Promise<StripePriceDetails | undefined> {
  const livePrice = subscription.items?.data?.at(0)?.price;
  if (!livePrice) return undefined;

  const price = toStripePriceDetails(livePrice);
  if (price.id !== billingRecord.stripePrice?.id) {
    await cacheStripePrice(price, owner);
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
    ...(typeof price.product === 'object' && price.product && 'name' in price.product
      ? { product_name: price.product.name }
      : {}),
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
  price: StripePriceDetails,
  owner: SubscriptionOwner,
): Promise<void> {
  await updateSubscription(owner, {
    UpdateExpression: 'SET stripePrice = :price, updatedAt = :now',
    ExpressionAttributeValues: {
      ':price': convertToAttr(price, { removeUndefinedValues: true }),
      ':now': { S: new Date().toISOString() },
    },
  });
}

async function evaluateStatusTransitions(
  billingRecord: SubscriptionRecord,
  storedStatus: SubscriptionStatus,
  owner: SubscriptionOwner,
): Promise<SubscriptionStatus> {
  let currentStatus = storedStatus;

  // Lazy eval: trial expired → grace_period
  if (
    currentStatus === SubscriptionStatus.Trialing &&
    billingRecord.trialEndsAt &&
    new Date(billingRecord.trialEndsAt).getTime() < Date.now()
  ) {
    const gracePeriodEndsAt = new Date(
      new Date(billingRecord.trialEndsAt).getTime() + TRIAL_GRACE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    await updateSubscription(owner, {
      UpdateExpression:
        'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        ':grace': { S: gracePeriodEndsAt },
        ':now': { S: new Date().toISOString() },
      },
    });
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
  { paymentMethod, monthlyMinimumCents, planName, pricePerTbCents }: StripeSubscriptionDetails,
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
      ...(billingRecord.currentPeriodStart
        ? { currentPeriodStart: billingRecord.currentPeriodStart }
        : {}),
      currentPeriodEnd: billingRecord.currentPeriodEnd,
      ...(billingRecord.canceledAt ? { canceledAt: billingRecord.canceledAt } : {}),
      ...(billingRecord.gracePeriodEndsAt
        ? { gracePeriodEndsAt: billingRecord.gracePeriodEndsAt }
        : {}),
      ...(monthlyMinimumCents ? { monthlyMinimumCents } : {}),
      ...(planName ? { planName } : {}),
      ...(pricePerTbCents ? { pricePerTbCents } : {}),
    },
    paymentMethod,
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('billing.view'))
  .use(errorHandlerMiddleware());
