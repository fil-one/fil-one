import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, DeleteParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStripeWebhookEndpoints = {
  list: vi.fn(),
  del: vi.fn(),
};

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhookEndpoints = mockStripeWebhookEndpoints;
  },
}));

const ssmMock = mockClient(SSMClient);

import { teardownStripeWebhook } from './teardown-stripe-webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTS = {
  stripeSecretKey: 'sk_test_fake',
  siteUrl: 'https://app.example.com',
  stage: 'dev',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('teardownStripeWebhook', () => {
  beforeEach(() => {
    ssmMock.reset();
    vi.clearAllMocks();
  });

  it('deletes existing webhook endpoint matching the site URL', async () => {
    mockStripeWebhookEndpoints.list.mockResolvedValue({
      data: [
        { id: 'we_other', url: 'https://other.example.com/api/stripe/webhook' },
        { id: 'we_match', url: 'https://app.example.com/api/stripe/webhook' },
      ],
    });
    mockStripeWebhookEndpoints.del.mockResolvedValue({});
    ssmMock.on(DeleteParameterCommand).resolves({});

    await teardownStripeWebhook(DEFAULT_OPTS);

    expect(mockStripeWebhookEndpoints.del).toHaveBeenCalledWith('we_match');
    expect(mockStripeWebhookEndpoints.del).not.toHaveBeenCalledWith('we_other');
  });

  it('deletes SSM parameter for the stage', async () => {
    mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
    ssmMock.on(DeleteParameterCommand).resolves({});

    await teardownStripeWebhook(DEFAULT_OPTS);

    expect(ssmMock.commandCalls(DeleteParameterCommand)[0].args[0].input).toEqual({
      Name: '/filone/dev/stripe-webhook-secret',
    });
  });

  it('succeeds when no matching endpoint exists', async () => {
    mockStripeWebhookEndpoints.list.mockResolvedValue({
      data: [{ id: 'we_other', url: 'https://other.example.com/api/stripe/webhook' }],
    });
    ssmMock.on(DeleteParameterCommand).resolves({});

    await teardownStripeWebhook(DEFAULT_OPTS);

    expect(mockStripeWebhookEndpoints.del).not.toHaveBeenCalled();
  });

  it('succeeds when SSM parameter does not exist', async () => {
    mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
    ssmMock.on(DeleteParameterCommand).rejects({ name: 'ParameterNotFound' });

    await teardownStripeWebhook(DEFAULT_OPTS);

    // Should not throw
  });

  it('logs warning but does not throw when Stripe API fails', async () => {
    mockStripeWebhookEndpoints.list.mockRejectedValue(new Error('Stripe is down'));
    ssmMock.on(DeleteParameterCommand).resolves({});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await teardownStripeWebhook(DEFAULT_OPTS);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Stripe'), expect.any(Error));
    warnSpy.mockRestore();
  });

  it('logs warning but does not throw when SSM delete fails with unexpected error', async () => {
    mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
    ssmMock.on(DeleteParameterCommand).rejects(new Error('AccessDenied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await teardownStripeWebhook(DEFAULT_OPTS);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SSM'), expect.any(Error));
    warnSpy.mockRestore();
  });
});
