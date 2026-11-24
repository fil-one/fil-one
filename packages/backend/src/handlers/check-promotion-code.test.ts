import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiErrorCode } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const mockPromotionCodesList = vi.fn();

vi.mock('../lib/stripe-client.ts', () => ({
  getStripeClient: () => ({
    promotionCodes: { list: mockPromotionCodesList },
  }),
}));

const mockGetSubscription = vi.fn();

vi.mock('../lib/subscription-store.ts', () => ({
  getSubscription: (...args: unknown[]) => mockGetSubscription(...args),
}));

const mockTakePromotionCodeCheck = vi.fn();

vi.mock('../lib/promotion-code-rate-limit.ts', () => ({
  takePromotionCodeCheck: (...args: unknown[]) => mockTakePromotionCodeCheck(...args),
}));

import { baseHandler } from './check-promotion-code.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

/**
 * A promotion code as Stripe lists it with its coupon expanded, open to every
 * customer and within its limits unless `code` says otherwise.
 */
function stripePromotionCode(coupon: Record<string, unknown>, code: Record<string, unknown> = {}) {
  return {
    id: 'promo_any',
    object: 'promotion_code',
    code: 'ANY-CODE',
    active: true,
    customer: null,
    expires_at: null,
    max_redemptions: null,
    times_redeemed: 0,
    ...code,
    promotion: {
      type: 'coupon',
      coupon: {
        id: 'any-coupon',
        object: 'coupon',
        percent_off: null,
        amount_off: null,
        duration: 'forever',
        duration_in_months: null,
        ...coupon,
      },
    },
  };
}

async function checkCode(body: string) {
  const result = await baseHandler(
    buildEvent({
      userInfo: { userId: 'any-user', orgId: 'any-org' },
      method: 'POST',
      rawPath: '/api/billing/promotion-code',
      body,
    }),
  );
  return { statusCode: result.statusCode, body: JSON.parse(String(result.body)) };
}

describe('check-promotion-code baseHandler', () => {
  beforeEach(() => {
    mockPromotionCodesList.mockReset();
    mockGetSubscription.mockReset();
    mockGetSubscription.mockResolvedValue({ stripeCustomerId: 'cus_this_org' });
    mockTakePromotionCodeCheck.mockReset();
    mockTakePromotionCodeCheck.mockResolvedValue({ allowed: true });
  });

  it('reports what an active code takes off, for how long', async () => {
    mockPromotionCodesList.mockResolvedValue({
      data: [
        stripePromotionCode({ percent_off: 20, duration: 'repeating', duration_in_months: 3 }),
      ],
    });

    expect(await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }))).toStrictEqual({
      statusCode: 200,
      body: {
        discount: {
          promotionCode: 'ANY-CODE',
          duration: 'repeating',
          durationInMonths: 3,
          percentOff: 20,
        },
      },
    });
  });

  it('looks the code up among active codes only, with its coupon expanded', async () => {
    mockPromotionCodesList.mockResolvedValue({
      data: [stripePromotionCode({ amount_off: 500 })],
    });

    await checkCode(JSON.stringify({ promotionCode: '  ANY-CODE ' }));

    expect(mockPromotionCodesList).toHaveBeenCalledWith({
      code: 'ANY-CODE',
      active: true,
      limit: 100,
      expand: ['data.promotion.coupon'],
    });
  });

  it("accepts the code restricted to this org's customer among codes sharing its text", async () => {
    mockPromotionCodesList.mockResolvedValue({
      data: [
        stripePromotionCode({ percent_off: 50 }, { customer: 'cus_other_org' }),
        stripePromotionCode({ percent_off: 20 }, { customer: 'cus_this_org' }),
      ],
    });

    expect(await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }))).toMatchObject({
      statusCode: 200,
      body: { discount: { percentOff: 20 } },
    });
    expect(mockGetSubscription).toHaveBeenCalledWith('any-org');
  });

  it.each([
    ['Stripe has no active code by that name', []],
    // A coupon with neither a percentage nor an amount has nothing to preview.
    ['the code takes nothing off', [stripePromotionCode({})]],
    [
      'the code is restricted to another customer',
      [stripePromotionCode({ percent_off: 20 }, { customer: 'cus_other_org' })],
    ],
    [
      'the code has expired',
      // An expiry one second after the epoch is long past.
      [stripePromotionCode({ percent_off: 20 }, { expires_at: 1 })],
    ],
    [
      'the code has been redeemed as often as it allows',
      [stripePromotionCode({ percent_off: 20 }, { max_redemptions: 5, times_redeemed: 5 })],
    ],
  ])('rejects the code as invalid when %s', async (_case, data) => {
    mockPromotionCodesList.mockResolvedValue({ data });

    expect(await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }))).toStrictEqual({
      statusCode: 400,
      body: {
        message: 'Invalid or expired promo code.',
        code: ApiErrorCode.INVALID_PROMOTION_CODE,
      },
    });
  });

  it.each([
    // Characters outside letters, digits and hyphens.
    ['a malformed code', JSON.stringify({ promotionCode: 'NOT A CODE!' })],
    // The field is required on this route.
    ['no code', JSON.stringify({})],
    // Not JSON at all.
    ['a body that is not JSON', 'not-json'],
  ])('rejects %s without asking Stripe', async (_case, body) => {
    const result = await checkCode(body);

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockPromotionCodesList).not.toHaveBeenCalled();
  });

  describe('the hourly allowance', () => {
    const NOW = new Date('2026-11-09T12:00:00.000Z');
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('refuses with 429 and when to try again once the org has spent it, without asking Stripe', async () => {
      const retryAt = new Date(NOW.getTime() + 40 * 60 * 1000);
      mockTakePromotionCodeCheck.mockResolvedValue({ allowed: false, retryAt });

      expect(await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }))).toStrictEqual({
        statusCode: 429,
        body: {
          message: 'Too many promo code attempts. Try again in 40 minutes.',
          code: ApiErrorCode.PROMOTION_CODE_RATE_LIMITED,
          retryAt: retryAt.toISOString(),
        },
      });
      expect(mockPromotionCodesList).not.toHaveBeenCalled();
    });

    it('says one minute, not zero, when the window is about to close', async () => {
      mockTakePromotionCodeCheck.mockResolvedValue({
        allowed: false,
        retryAt: new Date(NOW.getTime() + 10 * 1000),
      });

      expect(await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }))).toMatchObject({
        body: { message: 'Too many promo code attempts. Try again in 1 minute.' },
      });
    });

    it('spends from the caller org’s allowance', async () => {
      mockPromotionCodesList.mockResolvedValue({ data: [] });

      await checkCode(JSON.stringify({ promotionCode: 'ANY-CODE' }));

      expect(mockTakePromotionCodeCheck).toHaveBeenCalledWith('any-org');
    });

    it('spends nothing on a malformed request', async () => {
      // Not JSON, so it never reaches Stripe.
      await checkCode('not json');

      expect(mockTakePromotionCodeCheck).not.toHaveBeenCalled();
    });
  });
});
