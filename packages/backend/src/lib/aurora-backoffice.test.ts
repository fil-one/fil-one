import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./auth-secrets.js', () => ({
  getAuroraBackofficeSecrets: () => ({
    AURORA_BACKOFFICE_TOKEN: 'test-aurora-token',
  }),
}));

const mockPostTenants = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-aurora-client');

vi.mock('@hyperspace/aurora-backoffice-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  postPartnersByPartnerIdTenants: (options: Record<string, unknown>) => mockPostTenants(options),
}));

process.env.AURORA_BACKOFFICE_URL = 'https://api.backoffice.test.example.com/api/v1';
process.env.AURORA_PARTNER_ID = 'test-partner';
process.env.AURORA_REGION_ID = 'test-region';

import { createAuroraTenant } from './aurora-backoffice.js';

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
      baseUrl: 'https://api.backoffice.test.example.com/api/v1',
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
});
