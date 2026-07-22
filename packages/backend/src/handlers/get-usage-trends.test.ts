import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => fakeOrgProfile(orgId)),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './get-usage-trends.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { fakeOrchestrator, fakeOrgProfile, tenantFor } from '../test/fake-orchestrator.js';
import { S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
// fakeOrchestrator derives the tenant id from the orgId in the PROFILE item.
const AURORA_TENANT_ID = tenantFor('aurora', USER_INFO.orgId);

function storageSample(
  timestamp: string,
  bytesUsed: number,
  objectCount: number,
): { timestamp: string; bytesUsed: number; objectCount: number } {
  return { timestamp, bytesUsed, objectCount };
}

function flatTrend(length: number, value: number) {
  return Array.from({ length }, () => ({ date: expect.any(String), value }));
}

async function run(queryStringParameters?: Record<string, string>) {
  const result = await baseHandler(buildEvent({ userInfo: USER_INFO, queryStringParameters }));
  return { statusCode: result.statusCode, body: JSON.parse(String(result.body)) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-usage-trends baseHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a zero-filled 7-day series when no usage data exists', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

    const { statusCode, body } = await run();

    expect(statusCode).toBe(200);
    // Default period is 7d → 7 entries (from Jan 2 through Jan 8)
    expect(body).toStrictEqual({
      storage: flatTrend(7, 0),
      objects: flatTrend(7, 0),
    });
  });

  it('returns zero-filled trends without querying metrics when tenant is not ready', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    const aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const { statusCode, body } = await run();

    expect(statusCode).toBe(200);
    expect(body.storage).toStrictEqual(flatTrend(7, 0));
    expect(aurora.getTenantUsageMetrics).not.toHaveBeenCalled();
  });

  it('zero-fills missing days around real samples', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const aurora = fakeOrchestrator('aurora', {
      storage: [
        storageSample('2025-12-29T00:00:00.000Z', 1000, 5),
        storageSample('2025-12-31T00:00:00.000Z', 2000, 10),
      ],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const { body } = await run();

    // 7-day period from Dec 30 through Jan 5 = 7 entries
    expect(body.storage).toHaveLength(7);
    expect(body.storage[0]).toStrictEqual({ date: '2025-12-30T23:59:59.999Z', value: 0 });
    expect(body.storage[1]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 2000 });
    expect(body.storage[2]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });

    expect(body.objects[0]).toStrictEqual({ date: '2025-12-30T23:59:59.999Z', value: 0 });
    expect(body.objects[1]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 10 });
    expect(body.objects[2]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });
  });

  it('picks the latest intra-day reading regardless of sample order', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    // Same UTC day, delivered out of chronological order. The 22:00 reading is
    // the day's latest and must win even though it is not last in the array.
    const aurora = fakeOrchestrator('aurora', {
      storage: [
        storageSample('2026-01-03T22:00:00.000Z', 3000, 30),
        storageSample('2026-01-03T08:00:00.000Z', 1000, 10),
        storageSample('2026-01-03T15:00:00.000Z', 2000, 20),
      ],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const { body } = await run();

    const latest = '2026-01-03T23:59:59.999Z';
    expect(body.storage.find((p: { date: string }) => p.date === latest).value).toBe(3000);
    expect(body.objects.find((p: { date: string }) => p.date === latest).value).toBe(30);
  });

  it('fills correct number of entries for 30d period', async () => {
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

    const { body } = await run({ period: '30d' });

    // 30-day period from Jan 2 through Jan 31 = 30 entries
    expect(body.storage).toHaveLength(30);
    expect(body.objects).toHaveLength(30);
    // First entry should be Jan 2 end-of-day UTC
    expect(body.storage[0].date).toBe('2026-01-02T23:59:59.999Z');
  });

  it('defaults to a 7-day series for absent or unknown period values', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

    const absent = await run();
    expect(absent.body.storage).toHaveLength(7);

    const garbage = await run({ period: '90d' });
    expect(garbage.body.storage).toHaveLength(7);
  });

  it('requests the metrics window at 1d granularity', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    const aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await run({ period: '30d' });

    expect(aurora.getTenantUsageMetrics).toHaveBeenCalledWith(
      AURORA_TENANT_ID,
      expect.objectContaining({
        // 30-day window: Dec 10 start-of-day through now.
        from: '2025-12-10T00:00:00.000Z',
        to: '2026-01-08T12:00:00.000Z',
        interval: '1d',
      }),
    );
  });

  it('sums storage and objects across regions per day', async () => {
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [storageSample('2026-01-01T10:00:00.000Z', 1000, 5)],
    });
    const fth = fakeOrchestrator('fth', {
      region: S3Region.UsEast1,
      storage: [storageSample('2026-01-01T11:00:00.000Z', 500, 0)],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const { body } = await run();

    // Jan 1 storage is summed across regions: 1000 + 500 = 1500; objects: 5 + 0 = 5.
    const jan1 = '2026-01-01T23:59:59.999Z';
    expect(body.storage.find((p: { date: string }) => p.date === jan1).value).toBe(1500);
    expect(body.objects.find((p: { date: string }) => p.date === jan1).value).toBe(5);

    expect(aurora.getTenantUsageMetrics).toHaveBeenCalledWith(
      tenantFor('aurora', USER_INFO.orgId),
      expect.any(Object),
    );
    expect(fth.getTenantUsageMetrics).toHaveBeenCalledWith(
      tenantFor('fth', USER_INFO.orgId),
      expect.any(Object),
    );
  });

  it('still renders other regions when one orchestrator usage fetch fails', async () => {
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [storageSample('2026-01-01T10:00:00.000Z', 2000, 3)],
    });
    const fth = fakeOrchestrator('fth', { region: S3Region.UsEast1, failUsage: true });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const { statusCode, body } = await run();

    expect(statusCode).toBe(200);
    const jan1 = '2026-01-01T23:59:59.999Z';
    expect(body.storage.find((p: { date: string }) => p.date === jan1).value).toBe(2000);
  });
});
