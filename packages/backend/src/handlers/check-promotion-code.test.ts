import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { baseHandler } from './check-promotion-code.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

/** A promotion code as Stripe lists it with its coupon expanded. */
function stripePromotionCode(coupon: Record<string, unknown>) {
  return {
    id: 'promo_any',
    object: 'promotion_code',
    code: 'ANY-CODE',
    active: true,
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
      limit: 1,
      expand: ['data.promotion.coupon'],
    });
  });

  it.each([
    ['Stripe has no active code by that name', []],
    // A coupon with neither a percentage nor an amount has nothing to preview.
    ['the code takes nothing off', [stripePromotionCode({})]],
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
});
