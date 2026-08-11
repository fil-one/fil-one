import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockEnsureTenantReady = vi.fn();
const mockIssueAccessKey = vi.fn();
const mockFindAccessKeyByName = vi.fn();
const mockDeleteAccessKey = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
  issueAccessKey: (...args: unknown[]) => mockIssueAccessKey(...args),
  findAccessKeyByName: (...args: unknown[]) => mockFindAccessKeyByName(...args),
  deleteAccessKey: (...args: unknown[]) => mockDeleteAccessKey(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => {
    mockGetOrchestratorForRegion(region);
    return mockOrchestrator;
  },
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-access-key.js';
import { orgNotDeletingCheck } from '../lib/org-profile.js';
import { AccessKeyAlreadyExistsError } from '../lib/errors.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

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

/**
 * The `ACCESSKEY#` rows are written through a fenced transaction (FIL-112), so
 * every assertion about "the Put" reads item 1 — item 0 is always the deletion-guard
 * ConditionCheck (see sendGuardedWrite).
 */
function accessKeyPuts() {
  return ddbMock
    .commandCalls(TransactWriteItemsCommand)
    .map((call) => call.args[0].input.TransactItems![1].Put!);
}

/** The deletion-guard ConditionCheck of the first transaction sent. */
function sentGuardCheck() {
  return ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems![0]
    .ConditionCheck;
}

/** A fence rejection: item 0 (the ConditionCheck) is what DynamoDB cancelled on. */
function guardRejection() {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
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
    // The FIL-112 pre-check reads ORG#{orgId}/PROFILE; a live org has no
    // `deleting` attribute.
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } } });
    mockEnsureTenantReady.mockResolvedValue('aurora-t-1');
  });

  it('returns 201 with keyName, accessKeyId, and secretAccessKey on success', async () => {
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    const putCalls = accessKeyPuts();
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].Item!;
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

  describe('FIL-112 deletion fence', () => {
    it('pre-checks the profile strongly-consistently and never mints upstream when deleting', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' }, deleting: { BOOL: true } },
      });

      const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(410);
      expect(JSON.parse(result.body!)).toMatchObject({ code: 'ACCOUNT_DELETED' });
      // The whole point of pre-checking: no upstream credential is created, so
      // there is nothing that could be orphaned.
      expect(mockIssueAccessKey).not.toHaveBeenCalled();
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
      expect(accessKeyPuts()).toHaveLength(0);
      // `deleting` is absent until teardown starts, so a stale read fails open.
      expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toMatchObject({
        Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
        ConsistentRead: true,
      });
    });

    it('fences the DynamoDB write on the profile deleting flag as item 0', async () => {
      ddbMock.on(TransactWriteItemsCommand).resolves({});
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

      await baseHandler(
        buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
      );

      // The expression itself is pinned once, in org-profile.test.ts. Here the
      // contract is that this writer sends exactly that check, unmodified.
      expect(sentGuardCheck()).toEqual(orgNotDeletingCheck('org-1').ConditionCheck);
    });

    it('revokes the key it just minted when the fenced write loses the race', async () => {
      // The deletion is confirmed AFTER the pre-check but BEFORE the write, so
      // the credential exists upstream with no ACCESSKEY# row for teardown to
      // revoke by. Compensate.
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
      ddbMock.on(TransactWriteItemsCommand).rejects(guardRejection());
      mockDeleteAccessKey.mockResolvedValue(undefined);

      const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(410);
      expect(JSON.parse(result.body!)).toMatchObject({ code: 'ACCOUNT_DELETED' });
      // Blast radius: exactly one revoke, of exactly the key just issued, on
      // exactly this request's tenant. Never a listed or looked-up key.
      expect(mockDeleteAccessKey).toHaveBeenCalledTimes(1);
      expect(mockDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', 'aurora-key-1');
      // And the secret is never returned for a key that was just revoked.
      expect(result.body).not.toContain('secret-abc-123');
    });

    it('does NOT revoke when the write succeeds', async () => {
      ddbMock.on(TransactWriteItemsCommand).resolves({});
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

      const result = await baseHandler(
        buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
      );

      expect(result.statusCode).toBe(201);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    });

    it('does NOT revoke for a transaction failure that is not the fence', async () => {
      // A conflict/throttle must propagate as a 500 with the key intact — the
      // request can be retried; revoking here would destroy a usable key.
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
      ddbMock.on(TransactWriteItemsCommand).rejects(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
        }),
      );

      await expect(
        baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO })),
      ).rejects.toBeInstanceOf(TransactionCanceledException);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    });

    it('still answers 410 when the compensating revoke itself fails', async () => {
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
      ddbMock.on(TransactWriteItemsCommand).rejects(guardRejection());
      mockDeleteAccessKey.mockRejectedValue(new Error('orchestrator down'));

      const result = await baseHandler(
        buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
      );

      // A 500 here would only invite a retry that mints a second key.
      expect(result.statusCode).toBe(410);
    });

    it('skips the duplicate-key recovery record without revoking the pre-existing key', async () => {
      // The recovery path did not mint this key — it already existed upstream —
      // so a compensating revoke would destroy a credential this request never
      // created.
      mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      mockFindAccessKeyByName.mockResolvedValue({
        id: 'aurora-key-1',
        accessKeyId: 'AKIA1234567890',
        createdAt: '2026-03-10T00:00:00Z',
      });
      ddbMock.on(TransactWriteItemsCommand).rejects(guardRejection());

      const result = await baseHandler(
        buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
      );

      expect(result.statusCode).toBe(409);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
      // Teeth: the recovery row must not reach DynamoDB by ANY path. Before the
      // fence this was a bare PutItemCommand, which aws-sdk-client-mock resolves
      // by default — so the record was happily written for a deleting org and a
      // test asserting only the 409 pinned nothing. The single write attempted
      // now is the fenced transaction, and the fence rejected it.
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
      expect(sentGuardCheck()?.Key).toEqual({ pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } });
    });
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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

    const item = accessKeyPuts()[0].Item!;
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('throws when the orchestrator fails', async () => {
    mockIssueAccessKey.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(accessKeyPuts()).toHaveLength(0);
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
    expect(accessKeyPuts()).toHaveLength(0);
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      message: 'An access key with this name already exists',
    });
    // Verify DynamoDB record was recovered
    const putCalls = accessKeyPuts();
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].Item!;
    expect(item).toMatchObject({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'ACCESSKEY#aurora-key-1' },
      keyName: { S: 'My Key' },
      accessKeyId: { S: 'AKIA1234567890' },
      createdAt: { S: '2026-03-10T00:00:00Z' },
      status: { S: 'active' },
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'eu-west-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    expect(mockFindAccessKeyByName).toHaveBeenCalled();
    const putCalls = accessKeyPuts();
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].Item!;
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'us-east-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const putCalls = accessKeyPuts();
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].Item!;
    expect(item.region.S).toBe('us-east-1');
  });

  describe('region', () => {
    beforeEach(() => {
      ddbMock.on(TransactWriteItemsCommand).resolves({});
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
      const item = accessKeyPuts()[0].Item!;
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
      ddbMock.on(TransactWriteItemsCommand).resolves({});
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

      const item = accessKeyPuts()[0].Item!;
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
});
