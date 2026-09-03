import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

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
  // A mint that finds its creator demoted discards what it just made.
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
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.js';
import {
  buildEvent,
  membershipFor,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

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

/**
 * The two writes a mint makes: the intent, put on its own before the vendor
 * call, and the transaction carrying the key row with its completion event.
 *
 * Plus the read that follows them: the mint asks once more what role the
 * creator holds, and a suite that leaves it unstubbed is a suite where every
 * key is discarded for a demotion that never happened.
 */
function stubWrites(role: OrgRole = OrgRole.Owner) {
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
  stubCreatorRole(role);
}

/** What the post-write check reads. */
function stubCreatorRole(role: OrgRole | undefined) {
  stubMembershipRead(ddbMock, {
    orgId: USER_INFO.orgId,
    userId: USER_INFO.userId,
    role: role ?? OrgRole.Owner,
  });
}

/** Every transaction that wrote a key row (one per mint, or none). */
function keyRowWrites() {
  return ddbMock.commandCalls(TransactWriteItemsCommand);
}

/** The key row itself, found by its table rather than by its position. */
function keyRow() {
  const calls = keyRowWrites();
  expect(calls).toHaveLength(1);
  const items = calls[0].args[0].input.TransactItems ?? [];
  return items.find((item) => item.Put?.TableName === 'UserInfoTable')!.Put!.Item!;
}

/** The completion event, which rides beside it. */
function completionEvent() {
  return unmarshall(auditItemIn(keyRowWrites()[0].args[0].input.TransactItems));
}

/** Every event written on its own, in order: the intent and any completion. */
function standaloneEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

/** The intents, written before the vendor was called. */
function intentEvents() {
  return standaloneEvents().filter((event) => event.phase === 'intent');
}

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
    stubWrites();
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
    stubWrites();
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
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    const item = keyRow();
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
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: validBody({ keyName: 'My Key' }),
      userInfo: { ...USER_INFO, email: 'alice@example.com', emailVerified: true },
    });
    await baseHandler(event);

    const item = keyRow();
    expect(item.createdBy.S).toBe('user-1');
    expect(item.creatorEmail.S).toBe('alice@example.com');
    expect(item.policyVersion.S).toBe('pre-member-scope');
  });

  it('leaves the creator email off when the address is unverified', async () => {
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({
      body: validBody({ keyName: 'My Key' }),
      userInfo: { ...USER_INFO, email: 'alice@example.com', emailVerified: false },
    });
    await baseHandler(event);

    const item = keyRow();
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
    stubWrites();
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
    stubWrites();
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
    stubWrites();
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

    const item = keyRow();
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
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('throws when the orchestrator fails', async () => {
    mockIssueAccessKey.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(keyRowWrites()).toHaveLength(0);
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
    expect(keyRowWrites()).toHaveLength(0);
  });

  it('records an intent before the vendor mints, and a completion with the row', async () => {
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    await baseHandler(
      buildEvent({
        body: validBody({ keyName: 'My Key' }),
        userInfo: { ...USER_INFO, email: 'alice@example.com', emailVerified: true },
      }),
    );

    const [intent] = intentEvents();
    const completion = completionEvent();

    // The intent cannot name a key the vendor has not returned yet, which is
    // what makes a dangling one legible: a key was asked for by this name and
    // no completion followed.
    expect(intent).toMatchObject({
      pk: 'ORG#org-1',
      type: 'key.created',
      phase: 'intent',
      subject: 'org:org-1',
      actor: { kind: 'user', id: 'user-1', email: 'alice@example.com' },
      details: { keyKind: 's3', keyName: 'My Key', region: 'eu-west-1' },
    });
    // One subject for both halves, or the viewer cannot pair them: the mint has
    // no key id to file under until the vendor returns one, so the completion
    // names the key in `keyIdSuffix` instead.
    expect(completion).toMatchObject({
      type: 'key.created',
      phase: 'completion',
      outcome: 'succeeded',
      subject: 'org:org-1',
      details: { keyKind: 's3', keyName: 'My Key', keyIdSuffix: '7890' },
    });
    expect(completion.correlationId).toBe(intent.correlationId);
  });

  it('carries no credential into either half', async () => {
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    await baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }));

    for (const call of ddbMock.commandCalls(PutItemCommand)) {
      expectNoSecrets(call.args[0].input.Item ?? {});
    }
    expectNoSecrets(auditItemIn(keyRowWrites()[0].args[0].input.TransactItems));
  });

  it('closes the correlation as failed when the vendor rejects the request', async () => {
    stubWrites();
    mockIssueAccessKey.mockRejectedValue(new AccessKeyValidationError('bad expiry'));

    const result = await baseHandler(
      buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
    );

    // A dangling intent has to mean the process died mid-flight, so a request
    // the vendor refused closes its own correlation.
    expect(result.statusCode).toBe(400);
    const [intent, completion] = standaloneEvents();
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
    expect(completion.correlationId).toBe(intent.correlationId);
    expect(keyRowWrites()).toHaveLength(0);
  });

  it('never calls the vendor when the intent cannot be written', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    // Fail-closed: no credential may exist at the vendor without a record that
    // somebody asked for it, and here the vendor has not been called yet.
    await expect(
      baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO })),
    ).rejects.toThrow('AuditTable unavailable');
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('keeps the minted credential out of the event', async () => {
    stubWrites();
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    await baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }));

    const written = JSON.stringify([...intentEvents(), completionEvent()]);
    expect(written).not.toContain('secret-abc-123');
    // The access key id is recorded by its last characters only.
    expect(written).not.toContain('AKIA1234567890');
    expect(completionEvent().details.keyIdSuffix).toBe('7890');
  });

  it('leaves the intent dangling when the local write never lands', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('DynamoDB unavailable'));
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());

    await expect(
      baseHandler(buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO })),
    ).rejects.toThrow('DynamoDB unavailable');

    // A live SigV4 key now exists with no local row. The intent is the only
    // record that it was ever asked for, which is why it is written first.
    expect(intentEvents()).toHaveLength(1);
    expect(intentEvents()[0].phase).toBe('intent');
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
    stubWrites();

    const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      message: 'An access key with this name already exists',
    });
    // Verify DynamoDB record was recovered
    const item = keyRow();
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

    // The completion the earlier attempt never wrote, flagged the same way.
    expect(completionEvent()).toMatchObject({
      type: 'key.created',
      phase: 'completion',
      outcome: 'succeeded',
      subject: 'org:org-1',
      details: { keyKind: 's3', keyName: 'My Key', keyIdSuffix: '7890', recovered: true },
    });
    expect(completionEvent().correlationId).toBe(intentEvents()[0].correlationId);
    // The vendor's own timestamp for the attempt that minted the key, not this
    // retry's clock.
    expect(keyRow().createdAt).toStrictEqual({ S: '2026-03-10T00:00:00Z' });
  });

  it('closes the correlation as failed on a plain duplicate name', async () => {
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-1' },
          sk: { S: 'ACCESSKEY#aurora-key-1' },
          keyName: { S: 'My Key' },
          region: { S: 'eu-west-1' },
        },
      ],
    });
    stubWrites();

    const result = await baseHandler(
      buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
    );

    // Nothing to recover and nothing written, but the intent still has to be
    // closed or it reads as a mint whose process died.
    expect(result.statusCode).toBe(409);
    expect(keyRowWrites()).toHaveLength(0);
    const [intent, completion] = standaloneEvents();
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
    expect(completion.correlationId).toBe(intent.correlationId);
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
    stubWrites();

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'eu-west-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    expect(mockFindAccessKeyByName).toHaveBeenCalled();
    const item = keyRow();
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
    stubWrites();

    const event = buildEvent({
      body: validBody({ keyName: 'My Key', region: 'us-east-1' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const item = keyRow();
    expect(item.region.S).toBe('us-east-1');
  });

  describe('region', () => {
    beforeEach(() => {
      stubWrites();
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
      const item = keyRow();
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
      stubWrites();
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

      const item = keyRow();
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
      // The row has to agree with the session: the mint reads the role again
      // after writing, and a row saying something else is a demotion mid-flight.
      stubCreatorRole(role);
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
      stubWrites();
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
  /**
   * The permission cap runs against a role read before the vendor call, and the
   * vendor call is slow. Two checks cover a role change landing in that gap:
   * the key row's own `ConditionCheck`, and a read after the row lands. Only a
   * narrowing costs the key; a widening covers it.
   */
  describe('a role change during the mint', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubWrites();
      mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
      mockDeleteAccessKey.mockResolvedValue(undefined);
    });

    it('asks again once the row has landed', async () => {
      const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });
      await baseHandler(event);

      expect(
        ddbMock.commandCalls(GetItemCommand).map((call) => call.args[0].input.Key),
      ).toContainEqual({ pk: { S: 'ORG#org-1' }, sk: { S: 'MEMBER#user-1' } });
    });

    it('keeps the key when the role is the one the cap ran against', async () => {
      const event = buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO });

      expect((await baseHandler(event)).statusCode).toBe(201);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    });

    it('keeps the key when the role widened underneath it', async () => {
      // Every key a Member could mint, an Admin can: the key is valid under the
      // role they now hold, and a 409 would destroy it for nothing.
      stubCreatorRole(OrgRole.Admin);
      const event = buildEvent({
        body: validBody({ keyName: 'My Key' }),
        userInfo: {
          ...USER_INFO,
          membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, OrgRole.Member),
        },
      });

      expect((await baseHandler(event)).statusCode).toBe(201);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    });

    it('discards the key and the row when the role narrowed underneath it', async () => {
      // The row is already written, unlike the ConditionCheck path, so both
      // halves have to go.
      stubCreatorRole(OrgRole.Member);
      const event = buildEvent({
        body: validBody({ keyName: 'My Key' }),
        userInfo: {
          ...USER_INFO,
          membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, OrgRole.Owner),
        },
      });

      const result = await baseHandler(event);

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
      expect(mockDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', 'aurora-key-1');

      const deletes = keyRowWrites()
        .flatMap((call) => call.args[0].input.TransactItems ?? [])
        .filter((item) => item.Delete?.TableName === 'UserInfoTable');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.Delete!.Key).toStrictEqual({
        pk: { S: 'ORG#org-1' },
        sk: { S: 'ACCESSKEY#aurora-key-1' },
      });
    });

    it('records the discard as a revocation the member made of their own key', async () => {
      stubCreatorRole(OrgRole.Member);
      const event = buildEvent({
        body: validBody({ keyName: 'My Key' }),
        userInfo: {
          ...USER_INFO,
          membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, OrgRole.Owner),
        },
      });

      await baseHandler(event);

      const revocation = standaloneEvents().find((event) => event.type === 'key.deleted');
      expect(revocation).toMatchObject({
        phase: 'intent',
        actor: { kind: 'user', id: 'user-1' },
        details: { keyKind: 's3', reason: 'stale_role_at_mint', keyName: 'My Key' },
      });
    });

    it('discards the key when the member was removed outright', async () => {
      // No membership row at all: the row write's `attribute_exists(pk)` would
      // have refused a removal that landed first, so this is one that landed
      // after.
      stubAbsentMembershipRead(ddbMock, { orgId: USER_INFO.orgId, userId: USER_INFO.userId });

      expect(
        (
          await baseHandler(
            buildEvent({ body: validBody({ keyName: 'My Key' }), userInfo: USER_INFO }),
          )
        ).statusCode,
      ).toBe(409);
      expect(mockDeleteAccessKey).toHaveBeenCalled();
    });

    it('still answers 409 when the vendor will not take the key back', async () => {
      // The row survives, naming a credential that may still exist. Logged for
      // an operator rather than retried on a request path.
      stubCreatorRole(OrgRole.Member);
      mockDeleteAccessKey.mockRejectedValue(new Error('vendor down'));

      const result = await baseHandler(
        buildEvent({
          body: validBody({ keyName: 'My Key' }),
          userInfo: {
            ...USER_INFO,
            membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, OrgRole.Owner),
          },
        }),
      );

      expect(result.statusCode).toBe(409);
      expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('creator was demoted');
    });
  });
});
