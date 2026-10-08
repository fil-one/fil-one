import { describe, it, expect } from 'vitest';
import {
  ActivateSubscriptionRequestSchema,
  SubscriptionStatus,
  mapStripeStatus,
} from './billing.ts';

describe('mapStripeStatus', () => {
  it('maps active → Active', () => {
    expect(mapStripeStatus('active')).toBe(SubscriptionStatus.Active);
  });

  it('maps trialing → Trialing', () => {
    expect(mapStripeStatus('trialing')).toBe(SubscriptionStatus.Trialing);
  });

  it('maps past_due → PastDue', () => {
    expect(mapStripeStatus('past_due')).toBe(SubscriptionStatus.PastDue);
  });

  it('maps canceled → Canceled', () => {
    expect(mapStripeStatus('canceled')).toBe(SubscriptionStatus.Canceled);
  });

  it('maps unpaid → PastDue', () => {
    expect(mapStripeStatus('unpaid')).toBe(SubscriptionStatus.PastDue);
  });

  it('maps paused → PastDue', () => {
    expect(mapStripeStatus('paused')).toBe(SubscriptionStatus.PastDue);
  });

  it('maps incomplete_expired → Canceled', () => {
    expect(mapStripeStatus('incomplete_expired')).toBe(SubscriptionStatus.Canceled);
  });

  it('returns null for incomplete', () => {
    expect(mapStripeStatus('incomplete')).toBeNull();
  });

  it('returns null for unknown status strings', () => {
    expect(mapStripeStatus('some_future_status')).toBeNull();
  });
});

describe('ActivateSubscriptionRequestSchema', () => {
  it('accepts an empty object (no promotion code)', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({});
    expect(parsed).toStrictEqual({ success: true, data: { useSavedPaymentMethod: false } });
  });

  it('accepts a valid promotion code', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({ promotionCode: 'WELCOME20' });
    expect(parsed).toMatchObject({ success: true, data: { promotionCode: 'WELCOME20' } });
  });

  it('trims surrounding whitespace from the promotion code', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({ promotionCode: '  WELCOME20  ' });
    expect(parsed).toMatchObject({ success: true, data: { promotionCode: 'WELCOME20' } });
  });

  it('rejects promotion codes shorter than 3 characters', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({ promotionCode: 'ab' });
    expect(parsed).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_format',
            path: ['promotionCode'],
            message: 'Promo code must be 3–40 letters, digits, or hyphens.',
          },
        ],
      },
    });
  });

  it('rejects promotion codes longer than 40 characters', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({ promotionCode: 'A'.repeat(41) });
    expect(parsed).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_format',
            path: ['promotionCode'],
            message: 'Promo code must be 3–40 letters, digits, or hyphens.',
          },
        ],
      },
    });
  });

  it('rejects promotion codes containing spaces or punctuation', () => {
    const parsed = ActivateSubscriptionRequestSchema.safeParse({ promotionCode: 'bad code!' });
    expect(parsed).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_format',
            path: ['promotionCode'],
            message: 'Promo code must be 3–40 letters, digits, or hyphens.',
          },
        ],
      },
    });
  });
});
