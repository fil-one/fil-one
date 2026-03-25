import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAuroraTenant,
  setupAuroraTenant,
  getStorageSamples,
  createAuroraTenantApiKey,
} from './aurora-backoffice.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./auth-secrets.js', () => ({
  getAuroraBackofficeSecrets: () => ({
    AURORA_BACKOFFICE_TOKEN: 'test-aurora-token',
  }),
}));

const mockPostTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostSetup = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostTokens = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-aurora-client');
const mockGetStorage = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/aurora-backoffice-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  createTenant: (options: Record<string, unknown>) => mockPostTenants(options),
  listTenants: (options: Record<string, unknown>) => mockGetTenants(options),
  getTenantStorageMetrics: (options: Record<string, unknown>) => mockGetStorage(options),
  setupTenant: (options: Record<string, unknown>) => mockPostSetup(options),
  createTenantToken: (options: Record<string, unknown>) => mockPostTokens(options),
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

  it('throws when response has no token field', async () => {
    mockPostTokens.mockResolvedValue({
      data: { id: 'token-id-1' },
      error: undefined,
      response: { status: 201 },
    });

    await expect(
      createAuroraTenantApiKey({ tenantId: 'tenant-1', orgId: 'org-1' }),
    ).rejects.toThrow('Aurora API did not return a token for org org-1: {"id":"token-id-1"}');
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
});
