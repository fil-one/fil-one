import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type Stripe from 'stripe';
import { SubscriptionStatus } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

// The orchestrator registry instantiates real clients at import time; mock it
// so the otherwise-real region-helpers module can be loaded below.
vi.mock('./service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => [],
}));

const mockReportMetric = vi.fn();
vi.mock('./metrics.js', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { saveBillingRecord } from './billing-activation.js';
import { DELETION_GUARD } from './deletion-guard.js';

const USER_ID = 'user-1';

function mockSubscription(): Stripe.Subscription {
  return {
    id: 'sub_test_456',
    default_payment_method: {
      id: 'pm_test_789',
      card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
    },
    items: { data: [{ current_period_end: 1701209600 }] },
  } as unknown as Stripe.Subscription;
}

describe('saveBillingRecord', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockReportMetric.mockClear();
  });

  it('writes the record under the FIL-112 deletion guard and returns true', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const saved = await saveBillingRecord(
      USER_ID,
      mockSubscription(),
      'pm_test_789',
      SubscriptionStatus.Active,
    );

    expect(saved).toBe(true);
    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe(DELETION_GUARD);
    expect(input.Key).toEqual({ pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } });
  });

  it('returns false without throwing when the deletion guard rejects the write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const saved = await saveBillingRecord(
      USER_ID,
      mockSubscription(),
      'pm_test_789',
      SubscriptionStatus.Active,
    );

    expect(saved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mid-deletion'),
      expect.objectContaining({ key: expect.anything() }),
    );
    warnSpy.mockRestore();
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(
      saveBillingRecord(USER_ID, mockSubscription(), 'pm_test_789', SubscriptionStatus.Active),
    ).rejects.toThrow('throttled');
  });
});
