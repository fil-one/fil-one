import { describe, it, expect } from 'vitest';
import { SubscriptionStatus, mapStripeStatus } from './billing.js';

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
