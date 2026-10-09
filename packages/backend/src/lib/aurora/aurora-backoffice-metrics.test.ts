import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getStorageSamples,
  getOperationsSamples,
  getBucketStorageSamples,
} from './aurora-backoffice-metrics.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth-secrets.ts', () => ({
  getAuroraBackofficeSecrets: () => ({
    AURORA_BACKOFFICE_TOKEN: 'test-aurora-token',
  }),
}));

vi.mock('./aurora-api-metrics.ts', () => ({
  instrumentClient: vi.fn(),
}));

const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-aurora-client');
const mockGetStorage = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetOperations = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetBucketStorageMetrics = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/aurora-backoffice-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  getTenantStorageMetrics: (options: Record<string, unknown>) => mockGetStorage(options),
  getTenantOperationMetrics: (options: Record<string, unknown>) => mockGetOperations(options),
  getBucketStorageMetrics: (options: Record<string, unknown>) =>
    mockGetBucketStorageMetrics(options),
}));

process.env.AURORA_BACKOFFICE_URL = 'https://api.backoffice.test.example.com/api';
process.env.AURORA_PARTNER_ID = 'test-partner';
process.env.AURORA_REGION_ID = 'test-region';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStorageSamples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns samples on success', async () => {
    const mockSamples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000 },
    ];
    mockGetStorage.mockResolvedValue({ data: { samples: mockSamples }, error: undefined });

    const result = await getStorageSamples({
      tenantId: 'tenant-1',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
      window: '1h',
    });

    expect(result).toEqual(mockSamples);
    expect(mockGetStorage).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-1' },
      query: { from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z', window: '1h' },
      throwOnError: false,
    });
  });

  it('returns empty array when data has no samples', async () => {
    mockGetStorage.mockResolvedValue({ data: {}, error: undefined });

    const result = await getStorageSamples({
      tenantId: 'tenant-1',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
    });

    expect(result).toEqual([]);
  });

  it('throws with the HTTP status when the Aurora API returns an error', async () => {
    mockGetStorage.mockResolvedValue({
      data: undefined,
      error: { message: 'failed to fetch storage metrics' },
      response: { status: 500 },
    });

    await expect(
      getStorageSamples({
        tenantId: 'tenant-1',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora storage API failed for tenant tenant-1 (status=500');
  });

  it('throws with status=unknown when the error has no response', async () => {
    mockGetStorage.mockResolvedValue({ data: undefined, error: { message: 'Not found' } });

    await expect(
      getStorageSamples({
        tenantId: 'tenant-1',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora storage API failed for tenant tenant-1 (status=unknown');
  });

  // Aurora rejects single queries whose (to − from) span exceeds ~40 days. The
  // client transparently splits longer spans into ≤ 40-day sub-ranges. The
  // worst-case caller is the usage-reporting worker for grace-period
  // subscriptions whose currentPeriodStart can be ~60 days old.
  describe('range splitting', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('issues a single request when span ≤ 40 days', async () => {
      mockGetStorage.mockResolvedValue({ data: { samples: [] }, error: undefined });

      const from = new Date(Date.UTC(2024, 0, 1)).toISOString();
      const to = new Date(Date.parse(from) + 10 * DAY_MS).toISOString();

      await getStorageSamples({ tenantId: 'tenant-1', from, to, window: '1h' });

      expect(mockGetStorage).toHaveBeenCalledTimes(1);
      expect(mockGetStorage).toHaveBeenCalledWith(
        expect.objectContaining({ query: { from, to, window: '1h' } }),
      );
    });

    it('treats exactly 40 days as a single range (boundary inclusive)', async () => {
      mockGetStorage.mockResolvedValue({ data: { samples: [] }, error: undefined });

      const from = new Date(Date.UTC(2024, 0, 1)).toISOString();
      const to = new Date(Date.parse(from) + 40 * DAY_MS).toISOString();

      await getStorageSamples({ tenantId: 'tenant-1', from, to, window: '1h' });

      expect(mockGetStorage).toHaveBeenCalledTimes(1);
    });

    it('splits 40 days + 1ms into two ranges', async () => {
      mockGetStorage.mockResolvedValue({ data: { samples: [] }, error: undefined });

      const fromMs = Date.UTC(2024, 0, 1);
      const toMs = fromMs + 40 * DAY_MS + 1;
      const from = new Date(fromMs).toISOString();
      const to = new Date(toMs).toISOString();

      await getStorageSamples({ tenantId: 'tenant-1', from, to, window: '1h' });

      expect(mockGetStorage).toHaveBeenCalledTimes(2);
      const firstChunkTo = new Date(fromMs + 40 * DAY_MS).toISOString();
      expect(mockGetStorage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ query: { from, to: firstChunkTo, window: '1h' } }),
      );
      expect(mockGetStorage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ query: { from: firstChunkTo, to, window: '1h' } }),
      );
    });

    it('splits 62 days into two contiguous ranges and concatenates samples', async () => {
      const fromMs = Date.UTC(2024, 0, 1);
      const toMs = fromMs + 62 * DAY_MS;
      const from = new Date(fromMs).toISOString();
      const to = new Date(toMs).toISOString();
      const boundary = new Date(fromMs + 40 * DAY_MS).toISOString();

      const range1Samples = [
        { timestamp: '2024-01-15T00:00:00.000Z', bytesUsed: 100 },
        { timestamp: '2024-02-01T00:00:00.000Z', bytesUsed: 200 },
        { timestamp: '2024-02-09T00:00:00.000Z', bytesUsed: 250 },
        { timestamp: '2024-02-10T00:00:00.000Z', bytesUsed: 260 },
      ];
      const range2Samples = [
        { timestamp: '2024-02-11T00:00:00.000Z', bytesUsed: 275 },
        { timestamp: '2024-02-20T00:00:00.000Z', bytesUsed: 300 },
        { timestamp: '2024-03-01T00:00:00.000Z', bytesUsed: 400 },
      ];

      mockGetStorage.mockImplementation((options: Record<string, unknown>) => {
        const query = options.query as { from: string; to: string };
        if (query.from === from && query.to === boundary) {
          return Promise.resolve({ data: { samples: range1Samples }, error: undefined });
        }
        if (query.from === boundary && query.to === to) {
          return Promise.resolve({ data: { samples: range2Samples }, error: undefined });
        }
        const error = new Error(`Unexpected query range: from ${query.from} to ${query.to}`);
        return Promise.resolve({ data: undefined, error });
      });

      const result = await getStorageSamples({ tenantId: 'tenant-1', from, to, window: '1h' });

      expect(mockGetStorage).toHaveBeenCalledTimes(2);
      expect(result).toEqual([...range1Samples, ...range2Samples]);
    });

    it('dedupes overlapping boundary samples by timestamp', async () => {
      const fromMs = Date.UTC(2024, 0, 1);
      const toMs = fromMs + 62 * DAY_MS;
      const from = new Date(fromMs).toISOString();
      const to = new Date(toMs).toISOString();
      const boundary = new Date(fromMs + 40 * DAY_MS).toISOString();

      // Both ranges return a sample at the exact boundary timestamp.
      const range1Samples = [
        { timestamp: '2024-01-15T00:00:00.000Z', bytesUsed: 100 },
        { timestamp: boundary, bytesUsed: 200 },
      ];
      const range2Samples = [
        { timestamp: boundary, bytesUsed: 200 }, // duplicate
        { timestamp: '2024-03-01T00:00:00.000Z', bytesUsed: 400 },
      ];

      mockGetStorage
        .mockResolvedValueOnce({ data: { samples: range1Samples }, error: undefined })
        .mockResolvedValueOnce({ data: { samples: range2Samples }, error: undefined });

      const result = await getStorageSamples({ tenantId: 'tenant-1', from, to, window: '1h' });

      expect(result).toHaveLength(3);
      expect(result.map((s) => s.timestamp)).toEqual([
        '2024-01-15T00:00:00.000Z',
        boundary,
        '2024-03-01T00:00:00.000Z',
      ]);
    });
  });
});

describe('getOperationsSamples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  it('returns samples on success (single range path)', async () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', txBytes: 1000 },
      { timestamp: '2024-01-02T00:00:00Z', txBytes: 2000 },
    ];
    mockGetOperations.mockResolvedValue({
      data: { series: [{ samples }] },
      error: undefined,
    });

    const result = await getOperationsSamples({
      tenantId: 'tenant-1',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
      window: '24h',
    });

    expect(result).toEqual(samples);
    expect(mockGetOperations).toHaveBeenCalledTimes(1);
    expect(mockGetOperations).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-1' },
      query: { from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z', window: '24h' },
      throwOnError: false,
    });
  });

  it('returns empty array when data has no series', async () => {
    mockGetOperations.mockResolvedValue({ data: {}, error: undefined });

    const result = await getOperationsSamples({
      tenantId: 'tenant-1',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
    });

    expect(result).toEqual([]);
  });

  it('throws with the HTTP status when the Aurora API returns an error', async () => {
    mockGetOperations.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
      response: { status: 500 },
    });

    await expect(
      getOperationsSamples({
        tenantId: 'tenant-1',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora operations API failed for tenant tenant-1 (status=500');
  });

  it('splits 62-day spans into two contiguous ranges', async () => {
    const fromMs = Date.UTC(2024, 0, 1);
    const toMs = fromMs + 62 * DAY_MS;
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const boundary = new Date(fromMs + 40 * DAY_MS).toISOString();

    const range1Samples = [{ timestamp: '2024-01-15T00:00:00.000Z', txBytes: 500 }];
    const range2Samples = [{ timestamp: '2024-02-20T00:00:00.000Z', txBytes: 700 }];

    mockGetOperations.mockImplementation((options: Record<string, unknown>) => {
      const query = options.query as { from: string; to: string };
      if (query.from === from && query.to === boundary) {
        return Promise.resolve({
          data: { series: [{ samples: range1Samples }] },
          error: undefined,
        });
      }
      if (query.from === boundary && query.to === to) {
        return Promise.resolve({
          data: { series: [{ samples: range2Samples }] },
          error: undefined,
        });
      }

      const error = new Error(`Unexpected query range: from ${query.from} to ${query.to}`);
      return Promise.resolve({ data: undefined, error });
    });

    const result = await getOperationsSamples({
      tenantId: 'tenant-1',
      from,
      to,
      window: '24h',
    });

    expect(mockGetOperations).toHaveBeenCalledTimes(2);
    expect(result).toEqual([...range1Samples, ...range2Samples]);
  });

  // Critical: double-counting boundary txBytes would inflate the egress
  // total the worker reports to Stripe.
  it('dedupes overlapping boundary samples by timestamp', async () => {
    const fromMs = Date.UTC(2024, 0, 1);
    const toMs = fromMs + 62 * DAY_MS;
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const boundary = new Date(fromMs + 40 * DAY_MS).toISOString();

    const range1Samples = [
      { timestamp: '2024-01-15T00:00:00.000Z', txBytes: 500 },
      { timestamp: boundary, txBytes: 999 },
    ];
    const range2Samples = [
      { timestamp: boundary, txBytes: 999 },
      { timestamp: '2024-02-20T00:00:00.000Z', txBytes: 700 },
    ];

    mockGetOperations
      .mockResolvedValueOnce({ data: { series: [{ samples: range1Samples }] }, error: undefined })
      .mockResolvedValueOnce({ data: { series: [{ samples: range2Samples }] }, error: undefined });

    const result = await getOperationsSamples({
      tenantId: 'tenant-1',
      from,
      to,
      window: '24h',
    });

    expect(result).toHaveLength(3);
    const totalTxBytes = result.reduce((sum, s) => sum + (s.txBytes ?? 0), 0);
    expect(totalTxBytes).toBe(500 + 999 + 700);
  });
});

describe('getBucketStorageSamples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns samples on success', async () => {
    const mockSamples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 10 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 20 },
    ];
    mockGetBucketStorageMetrics.mockResolvedValue({
      data: { samples: mockSamples },
      error: undefined,
    });

    const result = await getBucketStorageSamples({
      bucketName: 'my-bucket',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
      window: '1h',
    });

    expect(result).toEqual(mockSamples);
    expect(mockGetBucketStorageMetrics).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', bucketName: 'my-bucket' },
      query: { from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z', window: '1h' },
      throwOnError: false,
    });
  });

  it('returns empty array when data has no samples', async () => {
    mockGetBucketStorageMetrics.mockResolvedValue({ data: {}, error: undefined });

    const result = await getBucketStorageSamples({
      bucketName: 'my-bucket',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
    });

    expect(result).toEqual([]);
  });

  it('throws with the HTTP status when the Aurora API returns an error', async () => {
    mockGetBucketStorageMetrics.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
      response: { status: 403 },
    });

    await expect(
      getBucketStorageSamples({
        bucketName: 'my-bucket',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora bucket storage API failed for bucket my-bucket (status=403)');
  });
});

describe('signal forwarding', () => {
  // The caller's deadline. Never aborted here: these tests check it reaches the
  // backoffice request, not what happens when it fires.
  const signal = new AbortController().signal;
  const range = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<{
    name: string;
    run: () => Promise<unknown>;
    mocks: Array<{ mock: { calls: unknown[][] } }>;
  }> = [
    {
      name: 'getStorageSamples',
      run: () => {
        mockGetStorage.mockResolvedValue({ data: { samples: [] }, error: undefined });
        return getStorageSamples({ tenantId: 't', ...range, signal });
      },
      mocks: [mockGetStorage],
    },
    {
      name: 'getBucketStorageSamples',
      run: () => {
        mockGetBucketStorageMetrics.mockResolvedValue({ data: { samples: [] }, error: undefined });
        return getBucketStorageSamples({ bucketName: 'b', ...range, signal });
      },
      mocks: [mockGetBucketStorageMetrics],
    },
    {
      name: 'getOperationsSamples',
      run: () => {
        mockGetOperations.mockResolvedValue({ data: { series: [] }, error: undefined });
        return getOperationsSamples({ tenantId: 't', ...range, signal });
      },
      mocks: [mockGetOperations],
    },
  ];

  for (const { name, run, mocks } of cases) {
    it(`${name} passes the caller's signal to every backoffice request`, async () => {
      await run();

      const firstArgs = mocks.map((m) => m.mock.calls[0]?.[0]);
      expect(firstArgs).toEqual(mocks.map(() => expect.objectContaining({ signal })));
    });
  }

  it('getStorageSamples passes the signal to each split range request', async () => {
    mockGetStorage.mockResolvedValue({ data: { samples: [] }, error: undefined });

    // 62 days: two ranges under the 40-day cap.
    await getStorageSamples({
      tenantId: 't',
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
      signal,
    });

    const options = mockGetStorage.mock.calls.map(([o]) => o);
    expect(options).toEqual([
      expect.objectContaining({ signal }),
      expect.objectContaining({ signal }),
    ]);
  });
});
