import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAuroraTenant,
  setupAuroraTenant,
  createAuroraTenantApiKey,
  DuplicateTokenNameError,
  updateTenantStatus,
  deleteAuroraTenant,
  getTenantInfo,
  getTenantStatus,
} from './aurora-backoffice.ts';

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

const mockPostTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockSetupS3Component = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostTokens = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-aurora-client');
const mockSetTenantStatus = vi.fn((_options: Record<string, unknown>) => ({}));
const mockDeleteTenant = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetTenant = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/aurora-backoffice-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  createTenantV2: (options: Record<string, unknown>) => mockPostTenants(options),
  listTenantsV2: (options: Record<string, unknown>) => mockGetTenants(options),
  setupS3Component: (options: Record<string, unknown>) => mockSetupS3Component(options),
  createTenantTokenV2: (options: Record<string, unknown>) => mockPostTokens(options),
  setTenantStatus: (options: Record<string, unknown>) => mockSetTenantStatus(options),
  deleteTenant: (options: Record<string, unknown>) => mockDeleteTenant(options),
  getTenantV2: (options: Record<string, unknown>) => mockGetTenant(options),
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

  it('creates the tenant through the v2 endpoint', async () => {
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

  // Aurora caps pageSize at 20, so the lookup filters by name instead of
  // scanning a page that may not hold the tenant.
  it('looks up the existing tenant by org name on 409 Conflict', async () => {
    mockPostTenants.mockResolvedValue({
      data: undefined,
      error: { message: 'Org already exists' },
      response: { status: 409 },
    });
    mockGetTenants.mockResolvedValue({
      data: { items: [{ id: 'existing-tenant-id', name: 'org-123' }] },
      error: undefined,
    });

    await createAuroraTenant({ orgId: 'org-123', displayName: 'My Org' });

    expect(mockGetTenants).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { partnerId: 'test-partner' },
        query: { orgName: 'org-123' },
      }),
    );
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

  it('returns lastSetupStep on success', async () => {
    mockSetupS3Component.mockResolvedValue({
      data: { enabled: true, lastSetupStep: 'FINISHED' },
      error: undefined,
    });

    const result = await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(result).toStrictEqual({ lastSetupStep: 'FINISHED' });
  });

  it('returns a non-FINISHED lastSetupStep value', async () => {
    mockSetupS3Component.mockResolvedValue({
      data: { enabled: true, lastSetupStep: 'WARM_TIER_ADDED' },
      error: undefined,
    });

    const result = await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(result).toStrictEqual({ lastSetupStep: 'WARM_TIER_ADDED' });
  });

  it('calls setupS3Component with correct parameters', async () => {
    mockSetupS3Component.mockResolvedValue({
      data: { enabled: true, lastSetupStep: 'FINISHED' },
      error: undefined,
    });

    await setupAuroraTenant({ tenantId: 'tenant-123' });

    expect(mockCreateClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.backoffice.test.example.com/api',
      headers: { 'X-Api-Key': 'test-aurora-token' },
    });

    expect(mockSetupS3Component).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-123' },
      throwOnError: false,
      parseAs: 'json',
    });
  });

  it('throws when the Aurora API returns an error', async () => {
    mockSetupS3Component.mockResolvedValue({
      data: undefined,
      error: { message: 'Setup failed' },
    });

    await expect(setupAuroraTenant({ tenantId: 'tenant-456' })).rejects.toThrow(
      'Aurora tenant setup failed for tenant tenant-456',
    );
  });

  it('throws when the Aurora API returns no data', async () => {
    mockSetupS3Component.mockResolvedValue({ data: undefined, error: undefined });

    await expect(setupAuroraTenant({ tenantId: 'tenant-789' })).rejects.toThrow(
      'Aurora API did not return setup data for tenant tenant-789',
    );
  });

  it('throws when the response is missing lastSetupStep', async () => {
    mockSetupS3Component.mockResolvedValue({
      data: { enabled: true },
      error: undefined,
    });

    await expect(setupAuroraTenant({ tenantId: 'tenant-789' })).rejects.toThrow(
      'Aurora API did not return lastSetupStep for tenant tenant-789',
    );
  });
});

describe('createAuroraTenantApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an S3-scoped token through the v2 endpoint', async () => {
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
      body: {
        name: 'filone-org-1',
        permissions: [
          'read:s3:access_keys',
          'create:s3:access_keys',
          'delete:s3:access_keys',
          'read:s3:buckets',
          'create:s3:buckets',
          'update:s3:buckets',
          'delete:s3:buckets',
        ],
      },
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

  // Retrying transient failures is the caller's responsibility (region-helpers
  // wraps the orchestrator call in pRetry), so this function does not retry.
  it('throws when the API returns an error', async () => {
    mockSetTenantStatus.mockResolvedValue({ error: { message: 'Service unavailable' } });

    await expect(updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED' })).rejects.toThrow(
      'Aurora status update failed for tenant tenant-1',
    );
  });

  it('does not retry when the API returns an error', async () => {
    mockSetTenantStatus.mockResolvedValue({ error: { message: 'Service unavailable' } });

    await updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED' }).catch(() => {});

    expect(mockSetTenantStatus).toHaveBeenCalledTimes(1);
  });

  it('throws on a 404 by default', async () => {
    mockSetTenantStatus.mockResolvedValue({
      error: { message: 'not found' },
      response: { status: 404 },
    });

    await expect(updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED' })).rejects.toThrow(
      'Aurora status update failed for tenant tenant-1',
    );
  });

  it('treats a 404 as success when allowMissing is set', async () => {
    mockSetTenantStatus.mockResolvedValue({
      error: { message: 'not found' },
      response: { status: 404 },
    });

    await expect(
      updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED', allowMissing: true }),
    ).resolves.toBeUndefined();
  });

  it('still throws on a non-404 when allowMissing is set', async () => {
    mockSetTenantStatus.mockResolvedValue({
      error: { message: 'boom' },
      response: { status: 500 },
    });

    await expect(
      updateTenantStatus({ tenantId: 'tenant-1', status: 'DISABLED', allowMissing: true }),
    ).rejects.toThrow('Aurora status update failed for tenant tenant-1');
  });
});

describe('deleteAuroraTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the tenant', async () => {
    mockDeleteTenant.mockResolvedValue({ error: undefined, response: { status: 204 } });

    await deleteAuroraTenant({ tenantId: 'tenant-1' });

    expect(mockDeleteTenant).toHaveBeenCalledWith({
      client: 'mock-aurora-client',
      path: { partnerId: 'test-partner', tenantId: 'tenant-1' },
      throwOnError: false,
    });
  });

  it('treats a 404 as success: the tenant is already gone', async () => {
    mockDeleteTenant.mockResolvedValue({
      error: { message: 'Tenant not found' },
      response: { status: 404 },
    });

    await expect(deleteAuroraTenant({ tenantId: 'tenant-1' })).resolves.toBeUndefined();
  });

  it.each([409, 500])('throws on a %i', async (status) => {
    mockDeleteTenant.mockResolvedValue({
      error: { message: 'Deletion not possible' },
      response: { status },
    });

    await expect(deleteAuroraTenant({ tenantId: 'tenant-1' })).rejects.toThrow(
      'Aurora tenant deletion failed for tenant tenant-1',
    );
  });
});

describe('signal forwarding', () => {
  // The caller's deadline. Never aborted here: these tests check it reaches the
  // backoffice request, not what happens when it fires.
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<{
    name: string;
    run: () => Promise<unknown>;
    mocks: Array<{ mock: { calls: unknown[][] } }>;
  }> = [
    {
      name: 'createAuroraTenant',
      run: () => {
        mockPostTenants.mockResolvedValue({ data: { id: 't' }, error: undefined });
        return createAuroraTenant({ orgId: 'org-1', displayName: 'Org', signal });
      },
      mocks: [mockPostTenants],
    },
    {
      name: 'createAuroraTenant on a 409 lookup',
      run: () => {
        mockPostTenants.mockResolvedValue({
          data: undefined,
          error: {},
          response: { status: 409 },
        });
        mockGetTenants.mockResolvedValue({
          data: { items: [{ id: 't', name: 'org-1' }] },
          error: undefined,
        });
        return createAuroraTenant({ orgId: 'org-1', displayName: 'Org', signal });
      },
      mocks: [mockPostTenants, mockGetTenants],
    },
    {
      name: 'setupAuroraTenant',
      run: () => {
        mockSetupS3Component.mockResolvedValue({
          data: { lastSetupStep: 'FINISHED' },
          error: undefined,
        });
        return setupAuroraTenant({ tenantId: 't', signal });
      },
      mocks: [mockSetupS3Component],
    },
    {
      name: 'createAuroraTenantApiKey',
      run: () => {
        mockPostTokens.mockResolvedValue({ data: { token: 'tok', id: 'id' }, error: undefined });
        return createAuroraTenantApiKey({ tenantId: 't', orgId: 'org-1', signal });
      },
      mocks: [mockPostTokens],
    },
    {
      name: 'getTenantInfo',
      run: () => {
        mockGetTenant.mockResolvedValue({ data: { id: 't' }, error: undefined });
        return getTenantInfo({ tenantId: 't', signal });
      },
      mocks: [mockGetTenant],
    },
    {
      name: 'getTenantStatus',
      run: () => {
        mockGetTenant.mockResolvedValue({
          data: { status: 'ACTIVE' },
          error: undefined,
          response: { status: 200 },
        });
        return getTenantStatus({ tenantId: 't', signal });
      },
      mocks: [mockGetTenant],
    },
    {
      name: 'deleteAuroraTenant',
      run: () => {
        mockDeleteTenant.mockResolvedValue({ error: undefined });
        return deleteAuroraTenant({ tenantId: 't', signal });
      },
      mocks: [mockDeleteTenant],
    },
    {
      name: 'updateTenantStatus',
      run: () => {
        mockSetTenantStatus.mockResolvedValue({ error: undefined });
        return updateTenantStatus({ tenantId: 't', status: 'ACTIVE', signal });
      },
      mocks: [mockSetTenantStatus],
    },
  ];

  for (const { name, run, mocks } of cases) {
    it(`${name} passes the caller's signal to every backoffice request`, async () => {
      await run();

      const firstArgs = mocks.map((m) => m.mock.calls[0]?.[0]);
      expect(firstArgs).toEqual(mocks.map(() => expect.objectContaining({ signal })));
    });
  }
});
