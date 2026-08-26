import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

const mockEnsureTenantReady = vi.fn();
const mockIssueAccessKey = vi.fn();
const mockFindAccessKeyByName = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
  issueAccessKey: (...args: unknown[]) => mockIssueAccessKey(...args),
  findAccessKeyByName: (...args: unknown[]) => mockFindAccessKeyByName(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => {
    mockGetOrchestratorForRegion(region);
    return mockOrchestrator;
  },
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

// Importing the handler module builds its Middy chain, so the middleware that
// chain installs is stubbed to a pass-through. The tests below call
// `baseHandler` directly.
vi.mock('../middleware/csrf.js', () => ({
  csrfMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.js', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

import { baseHandler } from './create-access-key.js';
import { AccessKeyAlreadyExistsError } from '../lib/errors.js';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody({ keyName, region = 'eu-west-1' }: { keyName?: string; region?: string }) {
  return JSON.stringify({
    keyName,
    permissions: ['read', 'write', 'list', 'delete'],
    bucketScope: 'all',
    region,
  });
}

function issuedAccessKey() {
  return {
    id: 'aurora-key-1',
    accessKeyId: 'AKIA1234567890',
    accessKeySecret: 'secret-abc-123',
    createdAt: '2026-03-10T13:36:07.752371Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-access-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    // The org-deleting fence pre-check; no `deleting` attribute by default.
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockEnsureTenantReady.mockResolvedValue('aurora-t-1');
  });

  it('410s without minting a key when the org is being deleted', async () => {
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } } })
      .resolves({ Item: { pk: { S: 'ORG#org-1' }, deleting: { BOOL: true } } });

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(410);
    expect(mockEnsureTenantReady).not.toHaveBeenCalled();
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('reads the fence consistently', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    await baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }));

    expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      ConsistentRead: true,
    });
  });

  it('returns 201 with keyName, accessKeyId, and secretAccessKey on success', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
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

  it('calls orchestrator.issueAccessKey with correct params', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockIssueAccessKey).toHaveBeenCalledWith('aurora-t-1', {
      keyName: 'My Key',
      permissions: ['read', 'write', 'list', 'delete'],
      granularPermissions: undefined,
      buckets: undefined,
      expiresAt: null,
    });
  });

  it('stores access key in DynamoDB without the secret', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
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
    expect(item.region.S).toBe('eu-west-1');
    // Secret must NOT be stored
    expect(item.accessKeySecret).toBeUndefined();
    expect(item.secretAccessKey).toBeUndefined();
  });

  it('records who minted the key and the policy era it was minted under', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: validBody({ keyName: 'My Key' }),
      userInfo: { ...USER_INFO, email: 'alice@example.com', emailVerified: true },
    });
    await baseHandler(event);

    const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
    expect(item.createdBy.S).toBe('user-1');
    expect(item.creatorEmail.S).toBe('alice@example.com');
    expect(item.policyVersion.S).toBe('pre-member-scope');
  });

  it('leaves the creator email off when the address is unverified', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: validBody({ keyName: 'My Key' }),
      userInfo: { ...USER_INFO, email: 'alice@example.com', emailVerified: false },
    });
    await baseHandler(event);

    const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
    expect(item.createdBy.S).toBe('user-1');
    expect(item.creatorEmail).toBeUndefined();
    expect(item.policyVersion.S).toBe('pre-member-scope');
  });

  it('returns 400 when keyName is missing', async () => {
    const event = buildEvent({ body: validBody({ keyName: undefined }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
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
        body: validBody({ keyName }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(mockIssueAccessKey).not.toHaveBeenCalled();
    });
  }

  it('trims whitespace from keyName', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: validBody({
        keyName: '  My Key  ',
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockIssueAccessKey).toHaveBeenCalledWith('aurora-t-1', {
      keyName: 'My Key',
      permissions: ['read', 'write', 'list', 'delete'],
      granularPermissions: undefined,
      buckets: undefined,
      expiresAt: null,
    });
    const body = JSON.parse(result.body!);
    expect(body.keyName).toBe('My Key');
  });

  it('passes YYYY-MM-DD expiresAt through as-is', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'My Key',
        permissions: ['read'],
        bucketScope: 'all',
        expiresAt: '2026-06-01',
        region: 'eu-west-1',
      }),
      userInfo: USER_INFO,
    });
    await baseHandler(event);

    expect(mockIssueAccessKey).toHaveBeenCalledWith(
      'aurora-t-1',
      expect.objectContaining({ expiresAt: '2026-06-01' }),
    );
  });

  it('stores the YYYY-MM-DD expiresAt in DynamoDB (not RFC3339)', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: JSON.stringify({
        keyName: 'My Key',
        permissions: ['read'],
        bucketScope: 'all',
        expiresAt: '2026-06-01',
        region: 'eu-west-1',
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
        region: 'eu-west-1',
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({
      message: 'expiresAt must be in YYYY-MM-DD format',
    });
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
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
        region: 'eu-west-1',
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({
      message: 'expiresAt must be in YYYY-MM-DD format',
    });
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({ body: 'not-json', userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 503 with a retry message when tenant setup fails', async () => {
    mockEnsureTenantReady.mockResolvedValue(null);

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body!);
    expect(body.message).toMatch(/setting up the region for you/i);
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('drives tenant setup via ensureTenantReady before creating the access key', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('throws when the orchestrator fails', async () => {
    mockIssueAccessKey.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 when the orchestrator rejects duplicate key name and key exists in DynamoDB', async () => {
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
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

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      message: 'An access key with this name already exists',
    });
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 and recovers DynamoDB record on partial failure', async () => {
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
    // No matching key in DynamoDB — partial failure
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    mockFindAccessKeyByName.mockResolvedValue({
      id: 'aurora-key-1',
      accessKeyId: 'AKIA1234567890',
      createdAt: '2026-03-10T00:00:00Z',
    });
    ddbMock.on(PutItemCommand).resolves({});

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
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
      // Attributed to the caller who retried, and flagged as such: a key with
      // no owner at all is the worse record.
      createdBy: { S: 'user-1' },
      policyVersion: { S: 'pre-member-scope' },
      recovered: { BOOL: true },
    });
  });

  it('recovers DynamoDB record when same keyName exists only in a different region', async () => {
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-1' },
          sk: { S: 'ACCESSKEY#fth-key-7' },
          keyName: { S: 'My Key' },
          accessKeyId: { S: 'AKIAOTHERREGION' },
          createdAt: { S: '2026-03-10T00:00:00Z' },
          status: { S: 'active' },
          region: { S: 'us-east-1' },
        },
      ],
    });
    mockFindAccessKeyByName.mockResolvedValue({
      id: 'aurora-key-1',
      accessKeyId: 'AKIA1234567890',
      createdAt: '2026-03-10T00:00:00Z',
    });
    ddbMock.on(PutItemCommand).resolves({});

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'eu-west-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    expect(mockFindAccessKeyByName).toHaveBeenCalled();
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item).toMatchObject({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'ACCESSKEY#aurora-key-1' },
      keyName: { S: 'My Key' },
      region: { S: 'eu-west-1' },
    });
  });

  it('treats DynamoDB rows without region as eu-west-1 (recovery proceeds when request region differs)', async () => {
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
    // Legacy row: matching keyName, no `region` attribute -> treated as eu-west-1
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-1' },
          sk: { S: 'ACCESSKEY#legacy-key-1' },
          keyName: { S: 'My Key' },
          accessKeyId: { S: 'AKIALEGACY' },
          createdAt: { S: '2026-01-01T00:00:00Z' },
          status: { S: 'active' },
        },
      ],
    });
    mockFindAccessKeyByName.mockResolvedValue({
      id: 'fth-key-7',
      accessKeyId: 'AKIA1234567890',
      createdAt: '2026-03-10T00:00:00Z',
    });
    ddbMock.on(PutItemCommand).resolves({});

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'us-east-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.region.S).toBe('us-east-1');
  });

  describe('region', () => {
    beforeEach(() => {
      ddbMock.on(PutItemCommand).resolves({});
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
    });

    it('fails when region is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          keyName: 'My Key',
          permissions: ['read'],
          bucketScope: 'all',
        }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
    });

    it('accepts eu-west-1', async () => {
      const event = buildEvent({
        body: validBody({ keyName: 'My Key', region: 'eu-west-1' }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(201);
    });

    it('accepts us-east-1 and routes to FTH', async () => {
      const event = buildEvent({
        body: validBody({ keyName: 'My Key', region: 'us-east-1' }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(201);
      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('us-east-1');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.region.S).toBe('us-east-1');
    });

    it('accepts us-east-1 in production for any user (soft-launched region)', async () => {
      const previous = process.env.FILONE_STAGE;
      process.env.FILONE_STAGE = 'production';
      try {
        const event = buildEvent({
          body: validBody({ keyName: 'My Key', region: 'us-east-1' }),
          userInfo: USER_INFO,
        });
        const result = await baseHandler(event);

        expect(result.statusCode).toBe(201);
        expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('us-east-1');
      } finally {
        process.env.FILONE_STAGE = previous;
      }
    });
  });

  describe('bucket management permissions', () => {
    beforeEach(() => {
      ddbMock.on(PutItemCommand).resolves({});
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
    });

    function bucketBody(region: string) {
      return JSON.stringify({
        keyName: 'My Key',
        permissions: ['read', 'CreateBucket', 'DeleteBucket'],
        bucketScope: 'all',
        region,
      });
    }

    it('passes bucket-management permissions to the orchestrator for a non-Aurora region', async () => {
      const event = buildEvent({ body: bucketBody('us-east-1'), userInfo: USER_INFO });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(201);
      expect(mockIssueAccessKey).toHaveBeenCalledWith(
        'aurora-t-1',
        expect.objectContaining({
          permissions: ['read', 'CreateBucket', 'DeleteBucket'],
        }),
      );
    });

    it('persists bucket-management permissions in DynamoDB', async () => {
      const event = buildEvent({ body: bucketBody('us-east-1'), userInfo: USER_INFO });
      await baseHandler(event);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.permissions.L).toEqual([
        { S: 'read' },
        { S: 'CreateBucket' },
        { S: 'DeleteBucket' },
      ]);
    });

    it('returns 400 for bucket-management permissions in the Aurora region', async () => {
      const event = buildEvent({ body: bucketBody('eu-west-1'), userInfo: USER_INFO });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(mockIssueAccessKey).not.toHaveBeenCalled();
    });
  });

  // ── The creator-authority cap ───────────────────────────────────────

  describe('the key cannot carry more than its creator', () => {
    // A SigV4 key is authority that leaves the console and is redeemed over S3,
    // where no role check runs until M3. Without this cap the console matrix is
    // decoration: a Member denied bucket deletion in the console would mint a
    // key and delete buckets with it.
    function keyRequest(
      role: OrgRole,
      body: { permissions: string[]; granularPermissions?: string[]; region?: string },
    ) {
      return buildEvent({
        body: JSON.stringify({
          keyName: 'My Key',
          bucketScope: 'all',
          region: body.region ?? 'us-east-1',
          permissions: body.permissions,
          ...(body.granularPermissions ? { granularPermissions: body.granularPermissions } : {}),
        }),
        userInfo: {
          ...USER_INFO,
          membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role),
        },
      });
    }

    beforeEach(() => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      ddbMock.on(PutItemCommand).resolves({});
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
    });

    it('lets a Member mint the four object permissions', async () => {
      const result = await baseHandler(
        keyRequest(OrgRole.Member, { permissions: ['read', 'list', 'write', 'delete'] }),
      );

      expect(result.statusCode).toBe(201);
    });

    it('lets a Member mint the bucket capabilities a Member already holds', async () => {
      // Creating a bucket is `buckets.create`, which a Member holds, and
      // reading a bucket's configuration is `buckets.read`. Refusing these
      // would 403 a Member who submitted the form untouched.
      const result = await baseHandler(
        keyRequest(OrgRole.Member, {
          permissions: ['read', 'CreateBucket', 'GetBucketVersioning'],
        }),
      );

      expect(result.statusCode).toBe(201);
    });

    it('refuses a Member bucket deletion, naming it', async () => {
      const result = await baseHandler(
        keyRequest(OrgRole.Member, { permissions: ['read', 'DeleteBucket', 'CreateBucket'] }),
      );

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body!)).toStrictEqual({
        message: 'A key cannot carry more than you do. Your role does not permit: DeleteBucket.',
        code: ApiErrorCode.FORBIDDEN_ROLE,
      });
      expect(mockIssueAccessKey).not.toHaveBeenCalled();
    });

    it('lets a Member mint the granulars that only narrow what they hold', async () => {
      const result = await baseHandler(
        keyRequest(OrgRole.Member, {
          permissions: ['read', 'delete'],
          granularPermissions: ['GetObjectRetention', 'DeleteObjectVersion'],
        }),
      );

      expect(result.statusCode).toBe(201);
    });

    it('refuses everyone below Owner the mutating retention granulars', async () => {
      for (const role of [OrgRole.Admin, OrgRole.Member]) {
        const result = await baseHandler(
          keyRequest(role, {
            permissions: ['write'],
            granularPermissions: ['PutObjectRetention'],
          }),
        );

        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body!).message).toContain('PutObjectRetention');
      }
    });

    it('lets an Owner mint them, holding privileged.grant', async () => {
      const result = await baseHandler(
        keyRequest(OrgRole.Owner, {
          permissions: ['write'],
          granularPermissions: ['PutObjectRetention', 'PutObjectLegalHold'],
        }),
      );

      expect(result.statusCode).toBe(201);
    });

    it('lets an Admin mint the bucket-management permissions', async () => {
      const result = await baseHandler(
        keyRequest(OrgRole.Admin, { permissions: ['read', 'DeleteBucket'] }),
      );

      expect(result.statusCode).toBe(201);
    });

    it('checks before minting anything at the provider', async () => {
      await baseHandler(keyRequest(OrgRole.Member, { permissions: ['DeleteBucket'] }));

      // The provider call is the irreversible half: a key minted there and
      // refused here would be a live credential with no record.
      expect(mockEnsureTenantReady).not.toHaveBeenCalled();
      expect(mockIssueAccessKey).not.toHaveBeenCalled();
    });
  });
});
