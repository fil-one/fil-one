import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { GB_BYTES, SubscriptionStatus } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: { BillingTable: { name: 'BillingTable' } },
}));

const mockReportMetric = vi.fn();
vi.mock('../lib/metrics.ts', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

const mockIsOrgDeletedOrDeleting = vi.fn(async (_orgId: string) => false);
vi.mock('../lib/org-profile.ts', () => ({
  isOrgDeletedOrDeleting: (orgId: string) => mockIsOrgDeletedOrDeleting(orgId),
}));

const mockGetOrgAggregateUsage = vi.fn();
vi.mock('../lib/org-usage-report.ts', () => ({
  getOrgAggregateUsage: (...args: unknown[]) => mockGetOrgAggregateUsage(...args),
}));

const mockListMeters = vi.fn();
const mockListEventSummaries = vi.fn();
vi.mock('../lib/stripe-client.ts', () => ({
  getStripeClient: () => ({
    billing: {
      meters: {
        list: (...args: unknown[]) => mockListMeters(...args),
        listEventSummaries: (...args: unknown[]) => mockListEventSummaries(...args),
      },
    },
  }),
}));

process.env.STRIPE_METER_EVENT_NAME = 'any-meter-event';

const ddbMock = mockClient(DynamoDBClient);

import { handler, measureUsageGap } from './billed-usage-drift-checker.ts';

const NOW = new Date('2026-11-19T09:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  const orgId = (overrides.orgId as string | undefined) ?? 'any-org';
  return marshall(
    {
      pk: `ORG#${orgId}`,
      sk: 'SUBSCRIPTION',
      orgId,
      userId: 'any-user',
      subscriptionId: 'any-sub',
      stripeCustomerId: 'any-customer',
      subscriptionStatus: SubscriptionStatus.Active,
      currentPeriodStart: '2026-10-20T10:00:00.000Z',
      currentPeriodEnd: new Date(NOW.getTime() + 24 * HOUR_MS).toISOString(),
      ...overrides,
    },
    // Lets a test drop a field by overriding it with undefined.
    { removeUndefinedValues: true },
  );
}

function givenActualGb(gb: number) {
  mockGetOrgAggregateUsage.mockResolvedValue({
    averageStorageBytesUsed: gb * GB_BYTES,
    currentStorageBytes: 0,
    totalEgressBytes: 0,
    sampleCount: 1,
  });
}

function givenBilledGb(gb: number | undefined) {
  mockListEventSummaries.mockResolvedValue({
    data: gb === undefined ? [] : [{ aggregated_value: gb }],
  });
}

function runSummary() {
  return mockReportMetric.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/** The checker's JSON warning lines for one event, parsed. */
function eventLogs(spy: ReturnType<typeof vi.spyOn>, event: string) {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls
    .filter((c) => typeof c[0] === 'string' && c[0].includes(event))
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
}
const outOfSyncLogs = (spy: ReturnType<typeof vi.spyOn>) => eventLogs(spy, 'out_of_sync');
const uncheckedLogs = (spy: ReturnType<typeof vi.spyOn>) => eventLogs(spy, 'unchecked');

describe('measureUsageGap', () => {
  it.each([
    { name: 'one missed run on steady storage', billedGb: 1200, actualGb: 1206, drifted: false },
    { name: 'a small account under the 1 GB floor', billedGb: 20, actualGb: 20.8, drifted: false },
    { name: 'a large gap after a week of failures', billedGb: 1200, actualGb: 1410, drifted: true },
    { name: 'nothing billed for real storage', billedGb: 0, actualGb: 350, drifted: true },
    {
      name: 'billed above actual by more than both limits',
      billedGb: 500,
      actualGb: 400,
      drifted: true,
    },
    { name: 'no storage and nothing billed', billedGb: 0, actualGb: 0, drifted: false },
  ])('reports drifted=$drifted for $name', ({ billedGb, actualGb, drifted }) => {
    expect(measureUsageGap({ billedGb, actualGb })).toMatchObject({ drifted });
  });

  it('measures the gap against the larger of the two values', () => {
    expect(measureUsageGap({ billedGb: 500, actualGb: 400 })).toStrictEqual({
      gapGb: 100,
      gapPct: 20,
      drifted: true,
    });
  });
});

describe('billed-usage-drift-checker handler', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ddbMock.reset();
    vi.clearAllMocks();
    mockIsOrgDeletedOrDeleting.mockResolvedValue(false);
    mockListMeters.mockResolvedValue({
      data: [
        { id: 'other-meter', event_name: 'other-event' },
        { id: 'any-meter-id', event_name: 'any-meter-event' },
      ],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs the org and the size of the gap when Stripe lags actual usage before invoicing', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow({ orgId: 'org-a' })] });
    givenBilledGb(1200);
    givenActualGb(1410);

    await handler();

    expect(outOfSyncLogs(warnSpy)).toStrictEqual([
      {
        event: '[billed-usage-drift-checker] out_of_sync',
        orgId: 'org-a',
        subscriptionId: 'any-sub',
        periodEnd: '2026-11-20T09:00:00.000Z',
        billedGb: 1200,
        actualGb: 1410,
        gapGb: 210,
        gapPct: 14.89,
      },
    ]);
    expect(runSummary()).toMatchObject({
      BilledUsageOrgsChecked: 1,
      BilledUsageDrift: 1,
      BilledUsageProbeFailed: 0,
    });
  });

  it('reads the billed value of the current period from the configured meter', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow()] });
    givenBilledGb(10);
    givenActualGb(10);

    await handler();

    expect(mockListEventSummaries).toHaveBeenCalledWith('any-meter-id', {
      customer: 'any-customer',
      // Stripe requires minute-aligned bounds.
      start_time: Math.floor(Date.parse('2026-10-20T10:00:00.000Z') / 1000),
      end_time: Math.floor(NOW.getTime() / 1000),
    });
    expect(mockGetOrgAggregateUsage).toHaveBeenCalledWith({
      orgId: 'any-org',
      from: '2026-10-20T10:00:00.000Z',
      to: NOW.toISOString(),
    });
  });

  it('treats a period with no meter value as nothing billed', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow()] });
    givenBilledGb(undefined);
    givenActualGb(350);

    await handler();

    expect(outOfSyncLogs(warnSpy)).toMatchObject([{ billedGb: 0, actualGb: 350, gapGb: 350 }]);
  });

  it.each([
    { name: 'the period ends more than 48 hours from now', hoursToEnd: 49 },
    { name: 'the period ended within the last 12 hours, pending renewal', hoursToEnd: -11 },
  ])('skips an org without a probe failure when $name', async ({ hoursToEnd }) => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        subscriptionRow({
          currentPeriodEnd: new Date(NOW.getTime() + hoursToEnd * HOUR_MS).toISOString(),
        }),
      ],
    });

    await handler();

    expect(mockListEventSummaries).not.toHaveBeenCalled();
    expect(runSummary()).toMatchObject({ BilledUsageOrgsChecked: 0, BilledUsageProbeFailed: 0 });
  });

  it.each([
    {
      name: 'an org on a trial, since Stripe does not charge usage during a trial',
      status: SubscriptionStatus.Trialing,
    },
    {
      name: 'an org in its grace period, since Stripe has canceled the subscription',
      status: SubscriptionStatus.GracePeriod,
    },
  ])('skips $name', async ({ status }) => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        subscriptionRow({
          subscriptionStatus: status,
          // A canceled row keeps its old period end, so it can sit in either window.
          currentPeriodEnd: new Date(NOW.getTime() - 24 * HOUR_MS).toISOString(),
        }),
      ],
    });

    await handler();

    expect(mockListEventSummaries).not.toHaveBeenCalled();
    expect(runSummary()).toMatchObject({ BilledUsageOrgsChecked: 0, BilledUsageProbeFailed: 0 });
  });

  it.each([
    {
      name: 'its period ended over 12 hours ago, so a renewal was missed',
      reason: 'stale-period',
      overrides: { currentPeriodEnd: new Date(NOW.getTime() - 13 * HOUR_MS).toISOString() },
    },
    {
      name: 'it has no period start',
      reason: 'missing-billing-fields',
      // Missing currentPeriodStart: the usage worker cannot meter it either.
      overrides: { currentPeriodStart: undefined },
    },
    {
      name: 'it has no Stripe customer',
      reason: 'missing-billing-fields',
      // Missing stripeCustomerId: nothing can be billed or read.
      overrides: { stripeCustomerId: undefined },
    },
  ])('reports a probe failure naming the org when $name', async ({ reason, overrides }) => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionRow({ orgId: 'org-a', ...overrides })],
    });

    await handler();

    expect(uncheckedLogs(warnSpy)).toMatchObject([{ orgId: 'org-a', reason }]);
    expect(runSummary()).toMatchObject({ BilledUsageOrgsChecked: 0, BilledUsageProbeFailed: 1 });
  });

  it('skips an org that is being deleted', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow()] });
    mockIsOrgDeletedOrDeleting.mockResolvedValue(true);

    await handler();

    expect(mockListEventSummaries).not.toHaveBeenCalled();
    expect(runSummary()).toMatchObject({ BilledUsageOrgsChecked: 0 });
  });

  it('counts a probe failure and carries on with the next org when a read fails', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionRow({ orgId: 'org-a' }), subscriptionRow({ orgId: 'org-b' })],
    });
    mockListEventSummaries
      .mockRejectedValueOnce(new Error('stripe unavailable'))
      .mockResolvedValueOnce({ data: [{ aggregated_value: 10 }] });
    givenActualGb(10);

    await handler();

    expect(errorSpy).toHaveBeenCalledWith('[billed-usage-drift-checker] probe failed', {
      orgId: 'org-a',
      error: expect.objectContaining({ message: 'stripe unavailable' }),
    });
    expect(runSummary()).toMatchObject({
      BilledUsageOrgsChecked: 1,
      BilledUsageDrift: 0,
      BilledUsageProbeFailed: 1,
    });
  });

  it('meters the same subscriptions the usage reporting run does', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)[0].args[0].input).toMatchObject({
      FilterExpression:
        'sk = :sk AND subscriptionStatus <> :canceled AND subscriptionStatus <> :manual ' +
        'AND attribute_exists(subscriptionId) AND attribute_not_exists(deletedAt)',
    });
  });

  it('fails the run when no Stripe meter matches the configured event name', async () => {
    mockListMeters.mockResolvedValue({ data: [{ id: 'other-meter', event_name: 'other-event' }] });
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow()] });

    await expect(handler()).rejects.toThrow(
      'No active Stripe meter with event name any-meter-event',
    );
  });

  it.each([
    {
      name: 'the Stripe meter lookup',
      // The meter lookup rejects, so no org can be checked.
      arrange: () => mockListMeters.mockRejectedValue(new Error('stripe unavailable')),
    },
    {
      name: 'the subscription scan',
      // The scan rejects, so no org can be found.
      arrange: () => ddbMock.on(ScanCommand).rejects(new Error('dynamo unavailable')),
    },
  ])('reports a probe failure before failing the run when $name fails', async ({ arrange }) => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionRow()] });
    arrange();

    await expect(handler()).rejects.toThrow('unavailable');

    expect(runSummary()).toMatchObject({
      BilledUsageOrgsChecked: 0,
      BilledUsageDrift: 0,
      BilledUsageProbeFailed: 1,
    });
  });
});
