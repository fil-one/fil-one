import { Resource } from 'sst';
import { recordRateLimitedRequest } from './rate-limit.ts';
import type { RateLimitResult } from './rate-limit.ts';

/**
 * How many promo codes one org may check in an hour. Room for typos, a second
 * code, reopening the payment modal and a teammate trying too, while a script
 * guessing codes gets 240 tries a day per org. That only slows guessing: a
 * private code stays safe by being long and random in Stripe.
 */
export const PROMOTION_CODE_CHECKS_PER_HOUR = 10;

/** Spend one of the org's promo code checks for the hour, or refuse. */
export function takePromotionCodeCheck(orgId: string, now?: Date): Promise<RateLimitResult> {
  return recordRateLimitedRequest({
    tableName: Resource.OrgTable.name,
    key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROMOTION_CODE_CHECK_RATE' } },
    max: PROMOTION_CODE_CHECKS_PER_HOUR,
    now,
  });
}
