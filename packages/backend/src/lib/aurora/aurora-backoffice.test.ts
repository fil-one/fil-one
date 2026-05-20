import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAuroraTenant,
  setupAuroraTenant,
  getStorageSamples,
  getOperationsSamples,
  createAuroraTenantApiKey,
  DuplicateTokenNameError,
  updateTenantStatus,
  getBucketStorageSamples,
} from './aurora-backoffice.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth-secrets.js', () => ({
  getAuroraBackofficeSecrets: () => ({
    AURORA_BACKOFFICE_TOKEN: 'test-aurora-token',
  }),
}));

vi.mock('./aurora-api-metrics.js', () => ({
  instrumentClient: vi.fn(),
}));

const mockPostTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostSetup = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostTokens = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-aurora-client');
const mockGetStorage = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetOperations = vi.fn((_options: Record<string, unknown>) => ({}));
const mockSetTenantStatus = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetBucketStorageMetrics = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/aurora-backoffice-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  createTenant: (options: Record<string, unknown>) => mockPostTenants(options),
  listTenants: (options: Record<string, unknown>) => mockGetTenants(options),
  getTenantStorageMetrics: (options: Record<string, unknown>) => mockGetStorage(options),
  getTenantOperationMetrics: (options: Record<string, unknown>) => mockGetOperations(options),
  setupTenant: (options: Record<string, unknown>) => mockPostSetup(options),
  createTenantToken: (options: Record<string, unknown>) => mockPostTokens(options),
  setTenantStatus: (options: Record<string, unknown>) => mockSetTenantStatus(options),
  getBucketStorageMetrics: (options: Record<string, unknown>) =>
    mockGetBucketStorageMetrics(options),
}));

process.env.AURORA_BACKOFFICE_URL = 'https://api.backoffice.test.example.com/api';
process.env.AURORA_PARTNER_ID = 'test-partner';
process.env.AURORA_REGION_ID = 'test-region';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuroraTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Aurora tenant id', async () => {
    mockPostTenants.mockResolvedValue({ data: { id: 'aurora-tenant-123' }, error: undefined });

    const result = await createAuroraTenant({ orgId: 'org-123', displayName: 'My Org' });

    expect(result).toStrictEqual({ auroraTenantId: 'aurora-tenant-123' });
  });

  it('calls postPartnersByPartnerIdTenants with correct parameters', async () => {
    mockPostTenants.mockResolvedValue({ data: { id: 'new-tenant' }, error: undefined });

    await createAuroraTenant({ orgId: 'org-123', displayName: 'My Org' });

    expect(mockCreateClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.backoffice.test.example.com/api',
      headers: { 'X-Api-Key': 'test-aurora-token' },
    });

    expect(mockPostTenants).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner' },
      body: {
        name: 'org-123',
        displayName: 'My Org',
        regionId: 'test-region',
      },
      throwOnError: false,
    });
  });

  it('throws when the Aurora API returns an error', async () => {
    mockPostTenants.mockResolvedValue({ data: undefined, error: { message: 'Bad request' } });

    await expect(
      createAuroraTenant({ orgId: 'org-456', displayName: 'Failing Org' }),
    ).rejects.toThrow('Aurora tenant creation failed for org org-456');
  });

  it('looks up existing tenant on 409 Conflict', async () => {
    mockPostTenants.mockResolvedValue({
      data: undefined,
      error: { message: 'Org already exists' },
      response: { status: 409 },
    });
    mockGetTenants.mockResolvedValue({
      data: {
        items: [
          { id: 'existing-tenant-id', name: 'org-123' },
          { id: 'other-tenant', name: 'org-other' },
        ],
      },
      error: undefined,
    });

    const result = await createAuroraTenant({ orgId: 'org-123', displayName: 'My Org' });

    expect(result).toStrictEqual({ auroraTenantId: 'existing-tenant-id' });
  });

  it('throws when 409 but tenant not found in list', async () => {
    mockPostTenants.mockResolvedValue({
      data: undefined,
      error: { message: 'Org already exists' },
      response: { status: 409 },
    });
    mockGetTenants.mockResolvedValue({
      data: { tenants: [{ id: 'other-tenant', name: 'org-other' }] },
      error: undefined,
    });

    await expect(createAuroraTenant({ orgId: 'org-123', displayName: 'My Org' })).rejects.toThrow(
      'Aurora tenant already exists for org org-123 but lookup failed',
    );
  });
});

describe('setupAuroraTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns id and lastSetupStep on success', async () => {
    mockPostSetup.mockResolvedValue({
      data: {
        id: 'tenant-123',
        components: {
          auth: { lastSetupStep: 'FINISHED' },
          compute: { lastSetupStep: 'FINISHED' },
          s3: { lastSetupStep: 'FINISHED' },
        },
      },
      error: undefined,
    });

    const result = await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(result).toStrictEqual({ id: 'tenant-123', lastSetupStep: 'FINISHED' });
  });

  it('returns a non-FINISHED lastSetupStep value', async () => {
    mockPostSetup.mockResolvedValue({
      data: {
        id: 'tenant-123',
        components: {
          auth: { lastSetupStep: 'FINISHED' },
          compute: { lastSetupStep: 'NOT_STARTED' },
          s3: { lastSetupStep: 'WARM_TIER_ADDED' },
        },
      },
      error: undefined,
    });

    const result = await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(result).toStrictEqual({ id: 'tenant-123', lastSetupStep: 'WARM_TIER_ADDED' });
  });

  it('calls setupTenant with correct parameters', async () => {
    mockPostSetup.mockResolvedValue({
      data: {
        id: 'tenant-123',
        components: { auth: { lastSetupStep: 'FINISHED' }, s3: { lastSetupStep: 'FINISHED' } },
      },
      error: undefined,
    });

    await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(mockCreateClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.backoffice.test.example.com/api',
      headers: { 'X-Api-Key': 'test-aurora-token' },
    });

    expect(mockPostSetup).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-123' },
      throwOnError: false,
      parseAs: 'json',
    });
  });

  it('throws when the Aurora API returns an error', async () => {
    mockPostSetup.mockResolvedValue({ data: undefined, error: { message: 'Setup failed' } });

    await expect(setupAuroraTenant({ tenantId: 'tenant-456' })).rejects.toThrow(
      'Aurora tenant setup failed for tenant tenant-456',
    );
  });

  it('throws when the Aurora API returns no data', async () => {
    mockPostSetup.mockResolvedValue({ data: undefined, error: undefined });

    await expect(setupAuroraTenant({ tenantId: 'tenant-789' })).rejects.toThrow(
      'Aurora API did not return setup data for tenant tenant-789',
    );
  });
});

describe('createAuroraTenantApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns token and tokenId on success', async () => {
    mockPostTokens.mockResolvedValue({
      data: { token: 'atp_secret123', id: 'token-id-1' },
      error: undefined,
      response: { status: 201 },
    });

    const result = await createAuroraTenantApiKey({
      tenantId: 'tenant-1',
      orgId: 'org-1',
    });

    expect(result).toStrictEqual({ token: 'atp_secret123', tokenId: 'token-id-1' });
    expect(mockPostTokens).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-1' },
      body: { name: 'filone-org-1' },
      throwOnError: false,
    });
  });

  it('throws on API error', async () => {
    mockPostTokens.mockResolvedValue({
      data: undefined,
      error: { message: 'forbidden' },
      response: { status: 403 },
    });

    await expect(
      createAuroraTenantApiKey({ tenantId: 'tenant-1', orgId: 'org-1' }),
    ).rejects.toThrow('Aurora API key creation failed for org org-1');
  });

  it('throws DuplicateTokenNameError on 409 Conflict', async () => {
    mockPostTokens.mockResolvedValue({
      data: undefined,
      error: { message: 'token name already exists' },
      response: { status: 409 },
    });

    expect(DuplicateTokenNameError).toBeDefined();
    await expect(
      createAuroraTenantApiKey({ tenantId: 'tenant-1', orgId: 'org-1' }),
    ).rejects.toBeInstanceOf(DuplicateTokenNameError);
  });

  it('throws when response has no token field', async () => {
    mockPostTokens.mockResolvedValue({
      data: { id: 'token-id-1' },
      error: undefined,
      response: { status: 201 },
    });

    await expect(
      createAuroraTenantApiKey({ tenantId: 'tenant-1', orgId: 'org-1' }),
    ).rejects.toThrow('Aurora API did not return a token for org org-1. Response fields: id');
  });
});

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

  it('throws when the Aurora API returns an error', async () => {
    mockGetStorage.mockResolvedValue({ data: undefined, error: { message: 'Not found' } });

    await expect(
      getStorageSamples({
        tenantId: 'tenant-1',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora storage API failed for tenant tenant-1');
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

  it('throws when the Aurora API returns an error', async () => {
    mockGetOperations.mockResolvedValue({ data: undefined, error: { message: 'Not found' } });

    await expect(
      getOperationsSamples({
        tenantId: 'tenant-1',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora operations API failed for tenant tenant-1');
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

  it('throws when the Aurora API returns an error', async () => {
    mockGetBucketStorageMetrics.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
    });

    await expect(
      getBucketStorageSamples({
        bucketName: 'my-bucket',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Aurora bucket storage API failed for bucket my-bucket');
  });
});

describe('updateTenantStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds on first attempt', async () => {
    mockSetTenantStatus.mockResolvedValue({ error: undefined });

    await updateTenantStatus({ tenantId: 'tenant-1', status: 'ACTIVE' });

    expect(mockSetTenantStatus).toHaveBeenCalledTimes(1);
    expect(mockSetTenantStatus).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-1' },
      body: { status: 'ACTIVE' },
      throwOnError: false,
    });
  });

  it('retries on transient failure then succeeds', async () => {
    vi.useFakeTimers();
    mockSetTenantStatus
      .mockResolvedValueOnce({ error: { message: 'Service unavailable' } })
      .mockResolvedValueOnce({ error: undefined });

    const promise = updateTenantStatus({ tenantId: 'tenant-1', status: 'WRITE_LOCKED' });
    await vi.runAllTimersAsync();
    await promise;

    expect(mockSetTenantStatus).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws after exhausting all retries', async () => {
    vi.useFakeTimers();
    mockSetTenantStatus.mockResolvedValue({ error: { message: 'Service unavailable' } });

    const promise = updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED' });
    const expectation = expect(promise).rejects.toThrow(
      'Aurora status update failed for tenant tenant-1',
    );
    await vi.runAllTimersAsync();
    await expectation;

    // 1 initial + 3 retries
    expect(mockSetTenantStatus).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
