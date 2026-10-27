import type { SubscriptionDiscount } from '@filone/shared';
import type Stripe from 'stripe';

/**
 * The active promotion code a customer typed, with its coupon expanded, or
 * undefined when Stripe has no active code by that name. Checking a code before
 * the card is submitted and applying it at activation both go through here, so
 * a code the modal accepted is one activation accepts too.
 */
export async function findActivePromotionCode(
  stripe: Stripe,
  code: string,
): Promise<Stripe.PromotionCode | undefined> {
  const matches = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 1,
    expand: ['data.promotion.coupon'],
  });
  return matches.data.at(0);
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
