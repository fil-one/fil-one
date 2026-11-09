import { Resource } from 'sst';
import { takeHourlyAllowance } from './hourly-allowance.ts';
import type { HourlyAllowance } from './hourly-allowance.ts';

/**
 * How many promo codes one org may check in an hour. Room for typos, a second
 * code, reopening the payment modal and a teammate trying too, while a script
 * guessing codes gets 240 tries a day per org. That only slows guessing: a
 * private code stays safe by being long and random in Stripe.
 */
export const PROMOTION_CODE_CHECKS_PER_HOUR = 10;

/** Spend one of the org's promo code checks for the hour, or refuse. */
export function takePromotionCodeCheck(orgId: string, now?: Date): Promise<HourlyAllowance> {
  return takeHourlyAllowance({
    tableName: Resource.OrgTable.name,
    key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROMOTION_CODE_CHECK_RATE' } },
    max: PROMOTION_CODE_CHECKS_PER_HOUR,
    now,
  });
}
