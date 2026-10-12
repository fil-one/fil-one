import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCustomersUpdate = vi.fn();
const mockPricesRetrieve = vi.fn();

vi.mock('stripe', () => ({
  default: class {
    customers = { update: mockCustomersUpdate };
    prices = { retrieve: mockPricesRetrieve };
  },
}));

vi.mock('sst', () => ({
  Resource: {
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

import { getSelfServeProductId, updateCustomerMetadata } from './stripe-client.ts';

describe('updateCustomerMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomersUpdate.mockResolvedValue({});
  });

  it('delegates to stripe.customers.update with metadata wrapper', async () => {
    await updateCustomerMetadata('cus_x', { foo: 'bar' });

    expect(mockCustomersUpdate).toHaveBeenCalledOnce();
    expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_x', {
      metadata: { foo: 'bar' },
    });
  });
});

describe('getSelfServeProductId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The module caches the first success, so these run in order: a failure,
  // then the success it retries into, then a call the cache answers.
  it('does not cache a failed lookup', async () => {
    mockPricesRetrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await expect(getSelfServeProductId()).rejects.toThrow('Stripe unavailable');
  });

  it('reads the product of the configured self-serve price', async () => {
    mockPricesRetrieve.mockResolvedValue({ id: 'price_test_fake', product: 'prod_self_serve' });

    await expect(getSelfServeProductId()).resolves.toBe('prod_self_serve');
    expect(mockPricesRetrieve).toHaveBeenCalledWith('price_test_fake');
  });

  it('asks Stripe only once per warm Lambda', async () => {
    await expect(getSelfServeProductId()).resolves.toBe('prod_self_serve');
    expect(mockPricesRetrieve).not.toHaveBeenCalled();
  });
});
