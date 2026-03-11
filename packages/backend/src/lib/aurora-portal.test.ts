import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPostBucket = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-portal-client');

vi.mock('@hyperspace/aurora-portal-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  postTenantsByTenantIdBucket: (options: Record<string, unknown>) => mockPostBucket(options),
}));

process.env.AURORA_PORTAL_URL = 'https://api.portal.test.example.com/api/v1';
process.env.HYPERSPACE_STAGE = 'test';

const ssmMock = mockClient(SSMClient);

import { createAuroraBucket, getAuroraPortalApiKey } from './aurora-portal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupSsmMock(apiKey = 'test-portal-api-key') {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: apiKey },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuroraBucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmMock.reset();
  });

  it('calls SSM with correct parameter name and WithDecryption', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({ error: undefined });

    await createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' });

    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/hyperspace/test/aurora-portal/tenant-api-key/tenant-1',
      WithDecryption: true,
    });
  });

  it('creates portal client with correct baseUrl and API key header', async () => {
    setupSsmMock('my-secret-key');
    mockPostBucket.mockResolvedValue({ error: undefined });

    await createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' });

    expect(mockCreateClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.portal.test.example.com/api/v1',
      headers: { 'X-Api-Key': 'my-secret-key' },
    });
  });

  it('calls postTenantsByTenantIdBucket with correct params', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({ error: undefined });

    await createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' });

    expect(mockPostBucket).toHaveBeenCalledWith({
      client: 'mock-portal-client',
      path: { tenantId: 'tenant-1' },
      body: { name: 'my-bucket' },
      throwOnError: false,
    });
  });

  it('succeeds on successful API response', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({ error: undefined });

    await expect(
      createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' }),
    ).resolves.toBeUndefined();
  });

  it('treats 409 Conflict as success', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({
      error: { message: 'Bucket already exists' },
      response: { status: 409 },
    });

    await expect(
      createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' }),
    ).resolves.toBeUndefined();
  });

  it('throws on non-409 API error', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({
      error: { message: 'Internal server error' },
      response: { status: 500 },
    });

    await expect(
      createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' }),
    ).rejects.toThrow('Failed to create Aurora bucket "my-bucket" for tenant tenant-1');
  });
});

describe('getAuroraPortalApiKey', () => {
  beforeEach(() => {
    ssmMock.reset();
  });

  it('calls SSM with correct parameter name and WithDecryption', async () => {
    setupSsmMock('my-key');

    await getAuroraPortalApiKey('test', 'tenant-1');

    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/hyperspace/test/aurora-portal/tenant-api-key/tenant-1',
      WithDecryption: true,
    });
  });

  it('returns the API key from SSM', async () => {
    setupSsmMock('my-secret-key');

    const result = await getAuroraPortalApiKey('test', 'tenant-1');

    expect(result).toBe('my-secret-key');
  });

  it('throws when SSM parameter is not found', async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('Parameter not found'), { name: 'ParameterNotFound' }));

    await expect(getAuroraPortalApiKey('test', 'tenant-1')).rejects.toThrow(
      'Aurora API key not found in SSM for tenant tenant-1',
    );
  });

  it('throws when SSM parameter has no value', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: undefined } });

    await expect(getAuroraPortalApiKey('test', 'tenant-1')).rejects.toThrow(
      'Aurora API key not found in SSM for tenant tenant-1',
    );
  });
});
