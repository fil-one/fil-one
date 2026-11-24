import type { SubscriptionDiscount } from '@filone/shared';
import type Stripe from 'stripe';

/**
 * The active promotion code a customer typed that this Stripe customer may
 * redeem, with its coupon expanded, or undefined when there is none. Checking a
 * code before the card is submitted and applying it at activation both go
 * through here, so a code the modal accepted is one activation accepts too.
 *
 * Stripe keeps a code's text unique per customer only, so several active codes
 * can share it, each restricted to a different customer. `customerId` is
 * undefined for an org that has no Stripe customer yet, which can redeem only
 * codes restricted to no one.
 */
export async function findActivePromotionCode(
  stripe: Stripe,
  code: string,
  customerId: string | undefined,
): Promise<Stripe.PromotionCode | undefined> {
  const matches = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 100,
    expand: ['data.promotion.coupon'],
  });
  const now = Date.now();
  return matches.data.find(
    (promotionCode) =>
      isRedeemableBy(promotionCode, customerId) && !isPastRedemptionLimits(promotionCode, now),
  );
}

/** Whether the code is open to every customer or restricted to this one. */
function isRedeemableBy(promotionCode: Stripe.PromotionCode, customerId: string | undefined) {
  const { customer } = promotionCode;
  if (customer === null) return true;
  return (typeof customer === 'string' ? customer : customer.id) === customerId;
}

/**
 * Whether the code has expired or been redeemed as often as it allows. Stripe
 * checks both only when the code is applied, so an `active` code can fail them.
 */
function isPastRedemptionLimits(promotionCode: Stripe.PromotionCode, now: number) {
  const { expires_at, max_redemptions, times_redeemed } = promotionCode;
  if (expires_at !== null && expires_at * 1000 <= now) return true;
  return max_redemptions !== null && times_redeemed >= max_redemptions;
}

/** What a promotion code would take off, before it is applied to anything. */
export function describePromotionCode(
  promotionCode: Stripe.PromotionCode,
): SubscriptionDiscount | undefined {
  return describeCoupon(promotionCode.promotion.coupon, { promotionCode: promotionCode.code });
}

/**
 * What a discount on a subscription takes off. Undefined when the coupon behind
 * it was not expanded, so callers listing a subscription's discounts drop the
 * ones they cannot describe rather than invent terms for them.
 */
export function describeSubscriptionDiscount(
  discount: Stripe.Subscription['discounts'][number],
): SubscriptionDiscount | undefined {
  if (typeof discount === 'string') return undefined;
  const promotionCode =
    typeof discount.promotion_code === 'object' ? discount.promotion_code?.code : undefined;
  return describeCoupon(discount.source.coupon, {
    promotionCode,
    endsAt: discount.end ? new Date(discount.end * 1000).toISOString() : undefined,
  });
}

function describeCoupon(
  coupon: string | Stripe.Coupon | null,
  { promotionCode, endsAt }: { promotionCode?: string; endsAt?: string },
): SubscriptionDiscount | undefined {
  if (typeof coupon !== 'object' || !coupon) return undefined;
  if (!isKnownDuration(coupon.duration)) return undefined;

  const terms = {
    ...(promotionCode ? { promotionCode } : {}),
    duration: coupon.duration,
    ...(coupon.duration_in_months ? { durationInMonths: coupon.duration_in_months } : {}),
    ...(endsAt ? { endsAt } : {}),
  };

  if (coupon.percent_off) return { ...terms, percentOff: coupon.percent_off };
  if (coupon.amount_off) return { ...terms, amountOffCents: coupon.amount_off };
  return undefined;
}

/**
 * Stripe types a coupon's duration as any string, to leave room for kinds it
 * adds later. One the console does not know how to word is left out.
 */
function isKnownDuration(duration: string): duration is SubscriptionDiscount['duration'] {
  return duration === 'once' || duration === 'repeating' || duration === 'forever';
}
