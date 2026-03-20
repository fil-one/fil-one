import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPostBucket = vi.fn((_options: Record<string, unknown>) => ({}));
const mockPostAccessKeys = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetAccessKeys = vi.fn((_options: Record<string, unknown>) => ({}));
const mockGetAccessKeyById = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => 'mock-portal-client');

const mockDeleteAccessKey = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/aurora-portal-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  postV1TenantsByTenantIdBucket: (options: Record<string, unknown>) => mockPostBucket(options),
  postV1TenantsByTenantIdAccessKeys: (options: Record<string, unknown>) =>
    mockPostAccessKeys(options),
  getV1TenantsByTenantIdAccessKeys: (options: Record<string, unknown>) =>
    mockGetAccessKeys(options),
  getV1TenantsByTenantIdAccessKeysByAccessKeyId: (options: Record<string, unknown>) =>
    mockGetAccessKeyById(options),
  deleteV1TenantsByTenantIdAccessKeysByAccessKeyId: (options: Record<string, unknown>) =>
    mockDeleteAccessKey(options),
}));

process.env.AURORA_PORTAL_URL = 'https://api.portal.test.example.com/api';
process.env.FILONE_STAGE = 'test';

const ssmMock = mockClient(SSMClient);

import {
  createAuroraAccessKey,
  createAuroraBucket,
  DuplicateKeyNameError,
  findAuroraAccessKeyByName,
  getAuroraPortalApiKey,
} from './aurora-portal.js';

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
      Name: '/filone/test/aurora-portal/tenant-api-key/tenant-1',
      WithDecryption: true,
    });
  });

  it('creates portal client with correct baseUrl and API key header', async () => {
    setupSsmMock('my-secret-key');
    mockPostBucket.mockResolvedValue({ error: undefined });

    await createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' });

    expect(mockCreateClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.portal.test.example.com/api',
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

  it('throws BucketAlreadyExistsError on 409 Conflict', async () => {
    setupSsmMock();
    mockPostBucket.mockResolvedValue({
      error: { message: 'Bucket already exists' },
      response: { status: 409 },
    });

    await expect(
      createAuroraBucket({ tenantId: 'tenant-1', bucketName: 'my-bucket' }),
    ).rejects.toThrow('Bucket "my-bucket" already exists');
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
      Name: '/filone/test/aurora-portal/tenant-api-key/tenant-1',
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

// ---------------------------------------------------------------------------
// createAuroraAccessKey
// ---------------------------------------------------------------------------

// Full-access array produced by buildAuroraAccessArray(['read','write','list','delete'])
const EXPECTED_ACCESS = [
  'Default',
  'GetBucketVersioning',
  'GetBucketObjectLockConfiguration',
  'Read',
  'GetObjectVersion',
  'GetObjectRetention',
  'GetObjectLegalHold',
  'Write',
  'PutObjectRetention',
  'PutObjectLegalHold',
  'List',
  'ListBucketVersions',
  'Delete',
  'DeleteObjectVersion',
];

const VALID_ACCESS_KEY_RESPONSE = {
  data: {
    accessKey: {
      id: 'ak-id-1',
      accessKeyId: 'AKIA-FAKE',
      accessKeySecret: 'secret-123',
      createdAt: '2026-03-12T00:00:00Z',
      name: 'my-key',
      modifiedAt: '2026-03-12T00:00:00Z',
      tenantId: 'tenant-1',
    },
  },
  error: undefined,
};

describe('createAuroraAccessKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmMock.reset();
  });

  it('calls SSM with correct parameter path using FILONE_STAGE', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue(VALID_ACCESS_KEY_RESPONSE);

    await createAuroraAccessKey({
      tenantId: 'tenant-1',
      keyName: 'my-key',
      permissions: ['read', 'write', 'list', 'delete'],
    });

    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-portal/tenant-api-key/tenant-1',
      WithDecryption: true,
    });
  });

  it('calls postV1TenantsByTenantIdAccessKeys with correct params', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue(VALID_ACCESS_KEY_RESPONSE);

    await createAuroraAccessKey({
      tenantId: 'tenant-1',
      keyName: 'my-key',
      permissions: ['read', 'write', 'list', 'delete'],
    });

    expect(mockPostAccessKeys).toHaveBeenCalledWith({
      client: 'mock-portal-client',
      path: { tenantId: 'tenant-1' },
      body: { name: 'my-key', access: EXPECTED_ACCESS },
      throwOnError: false,
    });
  });

  it('sends expiration as YYYY-MM-DD to Aurora', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue(VALID_ACCESS_KEY_RESPONSE);

    await createAuroraAccessKey({
      tenantId: 'tenant-1',
      keyName: 'my-key',
      permissions: ['read'],
      expiresAt: '2026-06-01',
    });

    expect(mockPostAccessKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ expiration: '2026-06-01' }),
      }),
    );
  });

  it('omits expiration field when expiresAt is null', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue(VALID_ACCESS_KEY_RESPONSE);

    await createAuroraAccessKey({
      tenantId: 'tenant-1',
      keyName: 'my-key',
      permissions: ['read'],
      expiresAt: null,
    });

    const body = (mockPostAccessKeys.mock.calls[0][0] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('expiration');
  });

  it('returns id, accessKeyId, accessKeySecret, createdAt on success', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue(VALID_ACCESS_KEY_RESPONSE);

    const result = await createAuroraAccessKey({
      tenantId: 'tenant-1',
      keyName: 'my-key',
      permissions: ['read', 'write', 'list', 'delete'],
    });

    expect(result).toStrictEqual({
      id: 'ak-id-1',
      accessKeyId: 'AKIA-FAKE',
      accessKeySecret: 'secret-123',
      createdAt: '2026-03-12T00:00:00Z',
    });
  });

  it('throws DuplicateKeyNameError on 409 response', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue({
      data: undefined,
      error: { message: 'Key with this name already exists' },
      response: { status: 409 },
    });

    try {
      await createAuroraAccessKey({
        tenantId: 'tenant-1',
        keyName: 'my-key',
        permissions: ['read', 'write', 'list', 'delete'],
      });
      expect.unreachable('Expected DuplicateKeyNameError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateKeyNameError);
      expect((err as DuplicateKeyNameError).message).toBe(
        'An access key with this name already exists',
      );
    }
  });

  it('throws on non-409 API error', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue({
      data: undefined,
      error: { message: 'Internal server error' },
      response: { status: 500 },
    });

    await expect(
      createAuroraAccessKey({
        tenantId: 'tenant-1',
        keyName: 'my-key',
        permissions: ['read', 'write', 'list', 'delete'],
      }),
    ).rejects.toThrow('Failed to create Aurora access key "my-key" for tenant tenant-1');
  });

  it('throws when accessKey is missing from response', async () => {
    setupSsmMock();
    mockPostAccessKeys.mockResolvedValue({
      data: {},
      error: undefined,
    });

    await expect(
      createAuroraAccessKey({
        tenantId: 'tenant-1',
        keyName: 'my-key',
        permissions: ['read', 'write', 'list', 'delete'],
      }),
    ).rejects.toThrow('Aurora API returned invalid access key for tenant tenant-1');
  });

  const requiredFields = ['id', 'accessKeyId', 'accessKeySecret', 'createdAt'] as const;
  for (const field of requiredFields) {
    it(`throws when "${field}" is missing from response`, async () => {
      setupSsmMock();
      mockPostAccessKeys.mockResolvedValue({
        data: {
          accessKey: {
            ...VALID_ACCESS_KEY_RESPONSE.data.accessKey,
            [field]: '',
          },
        },
        error: undefined,
      });

      await expect(
        createAuroraAccessKey({
          tenantId: 'tenant-1',
          keyName: 'my-key',
          permissions: ['read', 'write', 'list', 'delete'],
        }),
      ).rejects.toThrow(
        `Aurora Portal API returned empty access key "${field}" for tenant tenant-1`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// findAuroraAccessKeyByName
// ---------------------------------------------------------------------------

describe('findAuroraAccessKeyByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmMock.reset();
  });

  it('returns key details when key is found by name', async () => {
    setupSsmMock();
    mockGetAccessKeys.mockResolvedValue({
      data: {
        accessKeys: [
          { id: 'key-1', name: 'other-key' },
          { id: 'key-2', name: 'my-key' },
        ],
      },
      error: undefined,
    });
    mockGetAccessKeyById.mockResolvedValue({
      data: {
        accessKey: {
          id: 'key-2',
          name: 'my-key',
          accessKeyId: 'S3KEY123',
          createdAt: '2026-03-12T00:00:00Z',
        },
      },
      error: undefined,
    });

    const result = await findAuroraAccessKeyByName({ tenantId: 'tenant-1', keyName: 'my-key' });

    expect(result).toStrictEqual({
      id: 'key-2',
      accessKeyId: 'S3KEY123',
      createdAt: '2026-03-12T00:00:00Z',
    });
  });

  it('returns undefined when key is not found in list', async () => {
    setupSsmMock();
    mockGetAccessKeys.mockResolvedValue({
      data: {
        accessKeys: [{ id: 'key-1', name: 'other-key' }],
      },
      error: undefined,
    });

    const result = await findAuroraAccessKeyByName({ tenantId: 'tenant-1', keyName: 'my-key' });

    expect(result).toBeUndefined();
    expect(mockGetAccessKeyById).not.toHaveBeenCalled();
  });

  it('throws when list API call fails', async () => {
    setupSsmMock();
    mockGetAccessKeys.mockResolvedValue({
      data: undefined,
      error: { message: 'Server error' },
    });

    await expect(
      findAuroraAccessKeyByName({ tenantId: 'tenant-1', keyName: 'my-key' }),
    ).rejects.toThrow('Failed to list Aurora access keys for tenant tenant-1');
  });

  it('throws when get-by-id API call fails', async () => {
    setupSsmMock();
    mockGetAccessKeys.mockResolvedValue({
      data: {
        accessKeys: [{ id: 'key-2', name: 'my-key' }],
      },
      error: undefined,
    });
    mockGetAccessKeyById.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
    });

    await expect(
      findAuroraAccessKeyByName({ tenantId: 'tenant-1', keyName: 'my-key' }),
    ).rejects.toThrow('Failed to get Aurora access key "key-2" for tenant tenant-1');
  });
});
