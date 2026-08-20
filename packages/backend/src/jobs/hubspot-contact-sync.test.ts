import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MetricEvent, reportMetric } from '../lib/metrics.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: { BillingTable: { name: 'BillingTable' } },
}));

const mockGetContactStatus = vi.fn();
const mockUpsertContact = vi.fn();
vi.mock('../lib/hubspot-client.js', () => ({
  getContactSubscriptionStatus: (...args: unknown[]) => mockGetContactStatus(...args),
  upsertContactSubscriptionStatus: (...args: unknown[]) => mockUpsertContact(...args),
}));

const mockCustomersRetrieve = vi.fn();
vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({ customers: { retrieve: mockCustomersRetrieve } }),
}));

vi.mock('../lib/metrics.js', () => ({ reportMetric: vi.fn() }));

const reportMetricMock = vi.mocked(reportMetric);
const ddbMock = mockClient(DynamoDBClient);

import { handler, syncAllContacts } from './hubspot-contact-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record(overrides?: Record<string, unknown>) {
  return marshall({
    pk: 'CUSTOMER#user-1',
    sk: 'SUBSCRIPTION',
    stripeCustomerId: 'cus_1',
    orgId: 'org-1',
    subscriptionStatus: SubscriptionStatus.Active,
    ...overrides,
  });
}

function setupScan(...items: Record<string, unknown>[]) {
  ddbMock.on(ScanCommand).resolves({ Items: items as never });
}

describe('hubspot-contact-sync', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockGetContactStatus.mockReset();
    mockUpsertContact.mockReset();
    mockCustomersRetrieve.mockReset();
    reportMetricMock.mockReset();
    mockUpsertContact.mockResolvedValue('updated');
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_1', email: 'a@example.com' });
  });

  it('leaves a contact alone when it already holds the expected status', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue('paying');

    const summary = await syncAllContacts();

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ total: 1, matched: 1, repaired: 0, unmatched: 0 });
  });

  it('repairs a contact holding a stale value and counts it as a dropped write', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue('trialing');

    const summary = await syncAllContacts();

    expect(mockUpsertContact).toHaveBeenCalledWith({
      userId: 'user-1',
      status: 'paying',
      email: undefined,
    });
    expect(summary).toMatchObject({ matched: 1, repaired: 1 });
  });

  it('bootstraps an unstamped contact with the Stripe email, and does not count it as repaired', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue(null);
    mockUpsertContact.mockResolvedValue('bootstrapped');

    const summary = await syncAllContacts();

    expect(mockUpsertContact).toHaveBeenCalledWith({
      userId: 'user-1',
      status: 'paying',
      email: 'a@example.com',
    });
    expect(summary).toMatchObject({ matched: 1, repaired: 0 });
  });

  it('counts a contact HubSpot cannot match at all', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue(null);
    mockUpsertContact.mockResolvedValue('unmatched');

    const summary = await syncAllContacts();

    expect(summary).toMatchObject({ total: 1, unmatched: 1, matched: 0 });
  });

  it('does not look up a Stripe email when the contact is merely stale', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue('trialing');

    await syncAllContacts();

    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('skips the email when the Stripe customer was deleted', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue(null);
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_1', deleted: true });

    await syncAllContacts();

    expect(mockUpsertContact).toHaveBeenCalledWith(expect.objectContaining({ email: undefined }));
  });

  it('counts a HubSpot failure without aborting the rest of the run', async () => {
    setupScan(record(), record({ pk: 'CUSTOMER#user-2' }));
    mockGetContactStatus
      .mockRejectedValueOnce(new Error('HubSpot 503'))
      .mockResolvedValue('paying');

    const summary = await syncAllContacts();

    expect(summary).toMatchObject({ total: 2, writeFailed: 1, matched: 1 });
  });

  it('maps each stored status to its lifecycle value', async () => {
    setupScan(
      record({ pk: 'CUSTOMER#u1', subscriptionStatus: SubscriptionStatus.Trialing }),
      record({ pk: 'CUSTOMER#u2', subscriptionStatus: SubscriptionStatus.PastDue }),
      record({ pk: 'CUSTOMER#u3', subscriptionStatus: SubscriptionStatus.GracePeriod }),
    );
    mockGetContactStatus.mockResolvedValue('paying');

    await syncAllContacts();

    const statuses = mockUpsertContact.mock.calls.map(([args]) => args.status);
    expect(statuses).toEqual(['trialing', 'payment_failing', 'lapsed']);
  });

  it('paginates the scan', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [record()] as never, LastEvaluatedKey: { pk: { S: 'x' } } })
      .resolvesOnce({ Items: [record({ pk: 'CUSTOMER#user-2' })] as never });
    mockGetContactStatus.mockResolvedValue('paying');

    const summary = await syncAllContacts();

    expect(summary.total).toBe(2);
  });

  it('emits the run summary as a single EMF datapoint', async () => {
    setupScan(record());
    mockGetContactStatus.mockResolvedValue('paying');

    await handler();

    const emitted = reportMetricMock.mock.calls
      .map(([event]) => event)
      .filter((e) => (e as MetricEvent).HubSpotContactSyncTotal !== undefined);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      HubSpotContactSyncTotal: 1,
      HubSpotContactMatched: 1,
      HubSpotContactUnmatched: 0,
    });
  });
});
