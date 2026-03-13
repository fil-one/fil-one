import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';

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

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-access-key.js';
import { DuplicateKeyNameError } from '../lib/aurora-portal.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ keyName: 'My Key' });
}

function orgProfileWithTenant(tenantId: string) {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: tenantId },
      setupStatus: { S: 'AURORA_TENANT_API_KEY_CREATED' },
    },
  };
}

function orgProfileWithoutTenant() {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
    },
  };
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
  });

  it('returns 201 with keyName, accessKeyId, and secretAccessKey on success', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'My Key',
    });
  });

  it('stores access key in DynamoDB without the secret', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    'too long (257 chars)': 'a'.repeat(257),
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraAccessKey.mockResolvedValue(auroraAccessKeyResponse('My Key'));

    const event = buildEvent({
      body: JSON.stringify({ keyName: '  My Key  ' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'My Key',
    });
    const body = JSON.parse(result.body!);
    expect(body.keyName).toBe('My Key');
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({ body: 'not-json', userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithoutTenant());

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
  });

  it('throws when Aurora Portal API fails', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraAccessKey.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 when Aurora rejects duplicate key name and key exists in DynamoDB', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    expect(item).toStrictEqual({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'ACCESSKEY#aurora-key-1' },
      keyName: { S: 'My Key' },
      accessKeyId: { S: 'AKIA1234567890' },
      createdAt: { S: '2026-03-10T00:00:00Z' },
      status: { S: 'active' },
    });
  });
});
