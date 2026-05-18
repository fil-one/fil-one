import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateAuroraAccessKey = vi.fn();
const mockFindAuroraAccessKeyByName = vi.fn();

vi.mock('../lib/aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/aurora-portal.js')>();
  return {
    ...original,
    createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
    findAuroraAccessKeyByName: (...args: unknown[]) => mockFindAuroraAccessKeyByName(...args),
  };
});

const mockEnsureTenantReady = vi.fn();
vi.mock('../lib/aurora-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-access-key.js';
import { DuplicateKeyNameError } from '../lib/aurora-portal.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({
    keyName: 'My Key',
    permissions: ['read', 'write', 'list', 'delete'],
    bucketScope: 'all',
    region: 'eu-west-1',
  });
}

function auroraAccessKeyResponse(name: string) {
  return {
    id: 'aurora-key-1',
    name,
    accessKeyId: 'AKIA1234567890',
    accessKeySecret: 'secret-abc-123',
    createdAt: '2026-03-10T13:36:07.752371Z',
    modifiedAt: '2026-03-10T13:36:07.752371Z',
    tenantId: 'aurora-t-1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-access-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockEnsureTenantReady.mockResolvedValue({ ok: true, auroraTenantId: 'aurora-t-1' });
  });

  it('returns 201 with keyName, accessKeyId, and secretAccessKey on success', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      id: 'aurora-key-1',
      keyName: 'My Key',
      accessKeyId: 'AKIA1234567890',
      secretAccessKey: 'secret-abc-123',
      createdAt: '2026-03-10T13:36:07.752371Z',
    });
  });

  it('calls createAuroraAccessKey with correct params', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'My Key',
      permissions: ['read', 'write', 'list', 'delete'],
      buckets: undefined,
      expiresAt: null,
    });
  });

  it('stores access key in DynamoDB without the secret', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.pk.S).toBe('ORG#org-1');
    expect(item.sk.S).toBe('ACCESSKEY#aurora-key-1');
    expect(item.keyName.S).toBe('My Key');
    expect(item.accessKeyId.S).toBe('AKIA1234567890');
    expect(item.createdAt.S).toBe('2026-03-10T13:36:07.752371Z');
    expect(item.status.S).toBe('active');
    expect(item.bucketScope.S).toBe('all');
    // Secret must NOT be stored
    expect(item.accessKeySecret).toBeUndefined();
    expect(item.secretAccessKey).toBeUndefined();
  });

  it('returns 400 when keyName is missing', async () => {
    const event = buildEvent({ body: JSON.stringify({}), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
  });

  const invalidKeyNameCases: Record<string, string> = {
    'whitespace only': '   ',
    'empty string': '',
    'too long (65 chars)': 'a'.repeat(65),
    'special characters': 'key()!*$&@name',
  };

  for (const [desc, keyName] of Object.entries(invalidKeyNameCases)) {
    it(`returns 400 when keyName is ${desc}`, async () => {
      const event = buildEvent({
        body: JSON.stringify({ keyName }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
    });
  }

  it('trims whitespace from keyName', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({
      body: JSON.stringify({ keyName: '  My Key  ', permissions: ['read'], bucketScope: 'all' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'My Key',
      permissions: ['read'],
      buckets: undefined,
      expiresAt: null,
    });
    const body = JSON.parse(result.body!);
    expect(body.keyName).toBe('My Key');
  });

  it('passes YYYY-MM-DD expiresAt to Aurora as-is', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'My Key',
        permissions: ['read'],
        bucketScope: 'all',
        expiresAt: '2026-06-01',
      }),
      userInfo: USER_INFO,
    });
    await baseHandler(event);

    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: '2026-06-01' }),
    );
  });

  it('stores the YYYY-MM-DD expiresAt in DynamoDB (not RFC3339)', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'My Key',
        permissions: ['read'],
        bucketScope: 'all',
        expiresAt: '2026-06-01',
      }),
      userInfo: USER_INFO,
    });
    await baseHandler(event);

    const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
    expect(item.expiresAt.S).toBe('2026-06-01');
  });

  it('returns 400 when expiresAt is not in YYYY-MM-DD format', async () => {
    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'My Key',
        permissions: ['read'],
        bucketScope: 'all',
        expiresAt: '2026-04-16T12:34:56.789Z',
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({
      message: 'expiresAt must be in YYYY-MM-DD format',
    });
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
  });

  it('returns 400 when expiresAt is a timestamp formatted as ISO date-time string', async () => {
    // "joes 30 day key with all" was failing because the old CreateAccessKeyModal
    // sent d.toISOString() (with milliseconds) instead of YYYY-MM-DD
    const isoTimestamp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'joes 30 day key with all',
        permissions: ['read', 'write', 'list', 'delete'],
        bucketScope: 'all',
        expiresAt: isoTimestamp,
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({
      message: 'expiresAt must be in YYYY-MM-DD format',
    });
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({ body: 'not-json', userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 503 with a retry message when tenant setup fails', async () => {
    const errorResponse = {
      statusCode: 503,
      body: JSON.stringify({
        message: 'We are still setting up your account. Please try again in a moment.',
      }),
    };
    mockEnsureTenantReady.mockResolvedValue({ ok: false, errorResponse });

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body!);
    expect(body.message).toMatch(/setting up your account/i);
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
  });

  it('drives Aurora tenant setup via ensureTenantReady before creating the access key', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('throws when Aurora Portal API fails', async () => {
    mockCreateAuroraAccessKey.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 when Aurora rejects duplicate key name and key exists in DynamoDB', async () => {
    mockCreateAuroraAccessKey.mockRejectedValue(new DuplicateKeyNameError());
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-1' },
          sk: { S: 'ACCESSKEY#aurora-key-1' },
          keyName: { S: 'My Key' },
          accessKeyId: { S: 'AKIA1234567890' },
          createdAt: { S: '2026-03-10T00:00:00Z' },
          status: { S: 'active' },
        },
      ],
    });

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      message: 'An access key with this name already exists',
    });
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 and recovers DynamoDB record on partial failure', async () => {
    mockCreateAuroraAccessKey.mockRejectedValue(new DuplicateKeyNameError());
    // No matching key in DynamoDB — partial failure
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    mockFindAuroraAccessKeyByName.mockResolvedValue({
      id: 'aurora-key-1',
      accessKeyId: 'AKIA1234567890',
      createdAt: '2026-03-10T00:00:00Z',
    });
    ddbMock.on(PutItemCommand).resolves({});

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      message: 'An access key with this name already exists',
    });
    // Verify DynamoDB record was recovered
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item).toMatchObject({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'ACCESSKEY#aurora-key-1' },
      keyName: { S: 'My Key' },
      accessKeyId: { S: 'AKIA1234567890' },
      createdAt: { S: '2026-03-10T00:00:00Z' },
      status: { S: 'active' },
    });
  });

  describe('region', () => {
    beforeEach(() => {
      ddbMock.on(PutItemCommand).resolves({});
      mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));
    });

    it('succeeds when region is missing (back-compat with legacy callers)', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          keyName: 'My Key',
          permissions: ['read', 'write', 'list', 'delete'],
          bucketScope: 'all',
        }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(201);
    });

    it('accepts eu-west-1', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          keyName: 'My Key',
          permissions: ['read'],
          bucketScope: 'all',
          region: 'eu-west-1',
        }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(201);
    });

    it('rejects us-midwest-1', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          keyName: 'My Key',
          permissions: ['read'],
          bucketScope: 'all',
          region: 'us-midwest-1',
        }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.message).toContain('Unsupported region');
      expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
    });
  });
});
