import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCustomersUpdate = vi.fn();

vi.mock('stripe', () => ({
  default: class {
    customers = { update: mockCustomersUpdate };
  },
}));

vi.mock('sst', () => ({
  Resource: {
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

import { updateCustomerMetadata } from './stripe-client.js';

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
