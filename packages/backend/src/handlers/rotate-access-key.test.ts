import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

const mockEnsureTenantReady = vi.fn();
const mockIssueAccessKey = vi.fn();
const mockDeleteAccessKey = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
  issueAccessKey: (...args: unknown[]) => mockIssueAccessKey(...args),
  deleteAccessKey: (...args: unknown[]) => mockDeleteAccessKey(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  findOrchestratorById: () => mockOrchestrator,
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

import { ApiErrorCode, OrgRole } from '@filone/shared';
import { baseHandler } from './rotate-access-key.ts';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.ts';
import { RevocationNotRecordedError } from '../lib/key-revocation.ts';
import { buildEvent, membershipFor, stubMembershipRead } from '../test/lambda-test-utilities.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { OrgKeys } from '../lib/org-membership.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const KEY_ID = 'key-1';
const TENANT_ID = 'aurora-t-1';

/**
 * A stored key row, as the list shows it: owned by the caller, carrying a
 * permission set, and scoped to two buckets.
 */
const STORED_KEY = {
  pk: 'ORG#org-1',
  sk: `ACCESSKEY#${KEY_ID}`,
  keyName: 'My Key',
  accessKeyId: 'AKIAOLD00000000',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'active',
  region: 'eu-west-1',
  createdBy: USER_INFO.userId,
  permissions: ['read', 'write', 'list'],
  bucketScope: 'specific',
  buckets: ['alpha', 'beta'],
};

/** `'absent'` rather than `undefined`, which a default parameter cannot tell from "not passed". */
const NO_ROW = 'absent';

/** The row the handler reads. An override of `undefined` drops the attribute. */
function stubStoredKey(overrides: Record<string, unknown> | typeof NO_ROW = {}) {
  ddbMock
    .on(GetItemCommand, { Key: marshall({ pk: 'ORG#org-1', sk: `ACCESSKEY#${KEY_ID}` }) })
    .resolves(
      overrides === NO_ROW
        ? {}
        : { Item: marshall({ ...STORED_KEY, ...overrides }, { removeUndefinedValues: true }) },
    );
}

function issuedAccessKey() {
  return {
    id: 'aurora-key-2',
    accessKeyId: 'AKIANEW00000000',
    accessKeySecret: 'secret-abc-123',
    createdAt: '2026-09-11T10:00:00.000Z',
  };
}

/** A symbol, so the union with `string` stays a union the compiler can see. */
const NO_KEY_ID = Symbol('no keyId in the path');

function eventFor(role: OrgRole = OrgRole.Owner, keyId: string | typeof NO_KEY_ID = KEY_ID) {
  const event = buildEvent({
    userInfo: {
      ...USER_INFO,
      membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role),
    },
    method: 'POST',
  });
  // pathParameters isn't directly supported by buildEvent — attach it here.
  return Object.assign(event, {
    pathParameters: keyId === NO_KEY_ID ? undefined : { keyId },
  }) as unknown as AuthenticatedEvent;
}

/** The key's owner when that is not the caller, as the post-write recheck reads them. */
const OWNER = { orgId: USER_INFO.orgId, userId: 'user-2' };

/** The items of the mint transaction, so a test can say what rode alongside the row. */
function mintItems() {
  return transactions()[0].args[0].input.TransactItems ?? [];
}

/** Both writes a successful rotation makes, plus the role read between them. */
function stubWrites(role: OrgRole = OrgRole.Owner) {
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
  stubMembershipRead(ddbMock, { ...USER_INFO, role });
}

function transactions() {
  return ddbMock.commandCalls(TransactWriteItemsCommand);
}

/** The replacement's row, out of the mint transaction. */
function replacementRow() {
  const items = transactions()[0].args[0].input.TransactItems ?? [];
  return unmarshall(items.find((item) => item.Put?.TableName === 'UserInfoTable')!.Put!.Item!);
}

/** Every event written on its own: the mint intent, and the revocation's. */
function standaloneEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

function body(result: { body?: string }) {
  return JSON.parse(result.body ?? '{}');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rotate-access-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    // The org-deleting fence; no `deleting` attribute by default.
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockEnsureTenantReady.mockResolvedValue(TENANT_ID);
    mockIssueAccessKey.mockResolvedValue(issuedAccessKey());
    mockDeleteAccessKey.mockResolvedValue(undefined);
  });

  it('mints a replacement carrying everything the key already had', async () => {
    stubStoredKey();
    stubWrites();

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(201);
    expect(body(result)).toMatchObject({
      id: 'aurora-key-2',
      keyName: 'My Key',
      accessKeyId: 'AKIANEW00000000',
      secretAccessKey: 'secret-abc-123',
      previousKeyRevoked: true,
    });

    expect(mockIssueAccessKey).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        permissions: ['read', 'write', 'list'],
        buckets: ['alpha', 'beta'],
        expiresAt: null,
      }),
    );
  });

  it('mints under a suffixed name and keeps the name the row shows', async () => {
    stubStoredKey();
    stubWrites();

    await baseHandler(eventFor());

    const { keyName } = mockIssueAccessKey.mock.calls[0][1] as { keyName: string };
    expect(keyName).toMatch(/^My Key\.r[0-9a-f]{6}$/);

    const row = replacementRow();
    expect(row.keyName).toBe('My Key');
    expect(row.vendorKeyName).toBe(keyName);
  });

  it("carries the original's granulars, scope and expiry onto the new row", async () => {
    stubStoredKey({
      granularPermissions: ['GetObjectVersion'],
      expiresAt: '2099-01-01',
    });
    stubWrites();

    await baseHandler(eventFor());

    expect(replacementRow()).toMatchObject({
      accessKeyId: 'AKIANEW00000000',
      createdAt: '2026-09-11T10:00:00.000Z',
      status: 'active',
      // The network the key lives on, and no region: the stored row's legacy
      // region resolves to it and is not copied forward.
      orchestratorId: 'aurora',
      permissions: ['read', 'write', 'list'],
      granularPermissions: ['GetObjectVersion'],
      bucketScope: 'specific',
      buckets: ['alpha', 'beta'],
      expiresAt: '2099-01-01',
      // The replacement is attributed to whoever asked for it.
      createdBy: USER_INFO.userId,
    });
    expect(mockIssueAccessKey).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ expiresAt: '2099-01-01' }),
    );
  });

  it('revokes the key it replaces, and says so', async () => {
    stubStoredKey();
    stubWrites();

    await baseHandler(eventFor());

    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, KEY_ID);

    const revocationIntent = standaloneEvents().find((event) => event.type === 'key.deleted');
    expect(revocationIntent?.details).toMatchObject({ reason: 'rotation' });
  });

  it('records a rotation as its own event, naming the key being replaced', async () => {
    stubStoredKey();
    stubWrites();

    await baseHandler(eventFor());

    const mintIntent = standaloneEvents().find(
      (event) => event.type === 'key.rotated' && event.phase === 'intent',
    );
    expect(mintIntent?.details).toMatchObject({
      keyName: 'My Key',
      replacedKeyIdSuffix: expect.any(String),
    });

    const completion = unmarshall(auditItemIn(transactions()[0].args[0].input.TransactItems));
    expect(completion.outcome).toBe('succeeded');
    for (const event of [...standaloneEvents(), completion]) {
      expectNoSecrets(event as Record<string, never>);
    }
  });

  it('writes the mint intent before the vendor is called', async () => {
    stubStoredKey();
    stubWrites();
    mockIssueAccessKey.mockImplementation(() => {
      expect(standaloneEvents()).toHaveLength(1);
      return Promise.resolve(issuedAccessKey());
    });

    await baseHandler(eventFor());

    expect(mockIssueAccessKey).toHaveBeenCalled();
  });

  it('refuses a key the caller did not create', async () => {
    stubStoredKey({ createdBy: 'user-2' });

    const result = await baseHandler(eventFor(OrgRole.Member));

    expect(result.statusCode).toBe(403);
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it("rotates another member's key for a caller holding keys.manage_all", async () => {
    stubStoredKey({ createdBy: OWNER.userId });
    stubWrites();
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.Member });

    const result = await baseHandler(eventFor(OrgRole.Admin));

    expect(result.statusCode).toBe(201);
  });

  it("fences the owner's keys, not the rotator's, when they differ", async () => {
    // The replacement is the owner's key. A narrowing of the owner's role that
    // listed their keys a moment ago has to notice this row, and it fences on
    // the owner's mint sequence — bumping the Admin's would let it commit
    // against a stale listing and leave a credential the owner's new role
    // cannot hold.
    stubStoredKey({ createdBy: OWNER.userId });
    stubWrites();
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.Member });

    await baseHandler(eventFor(OrgRole.Admin));

    const roleCheck = mintItems().find((item) => item.ConditionCheck);
    const seqBump = mintItems().find((item) => item.Update?.TableName === 'OrgTable');
    expect(roleCheck?.ConditionCheck?.Key?.sk).toStrictEqual({ S: OrgKeys.memberSk(OWNER.userId) });
    expect(seqBump?.Update?.Key?.sk?.S).toMatch(new RegExp(`#${OWNER.userId}$`));
  });

  it("refuses when the owner's role can no longer hold the key", async () => {
    stubStoredKey({ createdBy: OWNER.userId });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    // The owner was demoted just after the row landed.
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.ReadOnly });

    const result = await baseHandler(eventFor(OrgRole.Admin));

    expect(result.statusCode).toBe(409);
    expect(body(result).message).toContain('owner');
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
    expect(mockDeleteAccessKey).not.toHaveBeenCalledWith(TENANT_ID, KEY_ID);
  });

  it('releases the claim on the old row when the replacement is discarded', async () => {
    // Left in place, the claim would strand the old key: live, listed, and
    // refused every rotation as already rotated, pointing at a key that is gone.
    stubStoredKey({ createdBy: OWNER.userId });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.ReadOnly });

    await baseHandler(eventFor(OrgRole.Admin));

    const release = ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input);
    expect(release).toHaveLength(1);
    expect(release[0].Key).toStrictEqual(marshall({ pk: 'ORG#org-1', sk: `ACCESSKEY#${KEY_ID}` }));
    expect(release[0].UpdateExpression).toBe('REMOVE replacedBy');
    expect(release[0].ConditionExpression).toBe('replacedBy = :ours');
    expect(release[0].ExpressionAttributeValues).toStrictEqual(
      marshall({ ':ours': 'aurora-key-2' }),
    );
  });

  it('keeps the claim when the discarded replacement may still be live', async () => {
    stubStoredKey({ createdBy: OWNER.userId });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.ReadOnly });
    mockDeleteAccessKey.mockRejectedValue(new Error('vendor unavailable'));

    await baseHandler(eventFor(OrgRole.Admin));

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("asserts the rotator's own authority when the key is somebody else's", async () => {
    // The owner's row is what the mint conditions; a caller demoted or removed
    // mid-flight would otherwise complete on the snapshot they arrived with.
    stubStoredKey({ createdBy: OWNER.userId });
    stubWrites();
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.Member });

    await baseHandler(eventFor(OrgRole.Admin));

    const checked = mintItems()
      .filter((item) => item.ConditionCheck)
      .map((item) => item.ConditionCheck?.Key?.sk?.S);
    expect(checked).toStrictEqual([
      OrgKeys.memberSk(OWNER.userId),
      OrgKeys.memberSk(USER_INFO.userId),
    ]);
  });

  it('conditions the row once when the caller is the owner', async () => {
    stubStoredKey();
    stubWrites();

    await baseHandler(eventFor());

    expect(mintItems().filter((item) => item.ConditionCheck)).toHaveLength(1);
  });

  it("refuses when the rotator's role changed mid-rotation", async () => {
    stubStoredKey({ createdBy: OWNER.userId });
    ddbMock.on(PutItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.Member });
    // Items: owner role, sequence, row, source claim, rotator role, audit.
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{}, {}, {}, {}, { Code: 'ConditionalCheckFailed' }, {}],
      }),
    );

    const result = await baseHandler(eventFor(OrgRole.Admin));

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(body(result).message).toContain('Your role');
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
    expect(mockDeleteAccessKey).not.toHaveBeenCalledWith(TENANT_ID, KEY_ID);
  });

  it('claims the row it replaces in the same transaction as the new one', async () => {
    stubStoredKey();
    stubWrites();

    await baseHandler(eventFor());

    const claim = mintItems().find((item) => item.Update?.TableName === 'UserInfoTable');
    expect(claim?.Update?.Key).toStrictEqual(
      marshall({ pk: 'ORG#org-1', sk: `ACCESSKEY#${KEY_ID}` }),
    );
    expect(claim?.Update?.ConditionExpression).toContain('attribute_not_exists(replacedBy)');
  });

  it('lets only one of two overlapping rotations land', async () => {
    // The second request read the same old row and minted its own replacement;
    // the claim on the source row refuses it, so its credential goes back and
    // the key it read is left alone.
    stubStoredKey();
    ddbMock.on(PutItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...USER_INFO, role: OrgRole.Owner });
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{}, {}, {}, { Code: 'ConditionalCheckFailed' }, {}],
      }),
    );

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(body(result).message).toContain('another request');
    expect(mockDeleteAccessKey).toHaveBeenCalledTimes(1);
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
  });

  it('refuses a key that already names its replacement', async () => {
    stubStoredKey({ replacedBy: 'aurora-key-9' });

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(body(result).message).toContain('already been rotated');
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it("leaves another member's key theirs after an Admin rotates it", async () => {
    // Moving `createdBy` to the Admin would drop the key out of its holder's
    // list and take away their right to revoke it, and the first they would
    // know of it is a client that stopped working.
    stubStoredKey({ createdBy: OWNER.userId, creatorEmail: 'them@example.com' });
    stubWrites();
    stubMembershipRead(ddbMock, { ...OWNER, role: OrgRole.Member });

    await baseHandler(eventFor(OrgRole.Admin));

    expect(replacementRow()).toMatchObject({
      createdBy: 'user-2',
      creatorEmail: 'them@example.com',
      // The Admin who reissued it is recorded beside the owner, not instead.
      rotatedBy: USER_INFO.userId,
      rotatedAt: '2026-09-11T10:00:00.000Z',
    });
  });

  it('gives an unattributed key no owner it never had', async () => {
    // A row naming nobody is visible only under `keys.manage_all`; inventing an
    // owner here would hand it to whoever happened to rotate it.
    stubStoredKey({ createdBy: undefined });
    stubWrites();

    await baseHandler(eventFor(OrgRole.Admin));

    expect(replacementRow()).not.toHaveProperty('createdBy');
  });

  it('refuses a key carrying more than the caller could mint today', async () => {
    // `PutObjectRetention` needs `privileged.grant`, which only an Owner holds.
    stubStoredKey({ granularPermissions: ['PutObjectRetention'] });

    const result = await baseHandler(eventFor(OrgRole.Admin));

    expect(result.statusCode).toBe(403);
    expect(body(result).message).toContain('PutObjectRetention');
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('refuses a role that cannot mint keys at all', async () => {
    stubStoredKey();

    const result = await baseHandler(eventFor(OrgRole.ReadOnly));

    expect(result.statusCode).toBe(403);
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('refuses a row that never recorded what its key carries', async () => {
    stubStoredKey({ permissions: undefined });

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(body(result).message).toContain('never recorded');
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('refuses a key whose expiry has already passed', async () => {
    stubStoredKey({ expiresAt: '2020-01-01' });

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(400);
    expect(body(result).message).toContain('2020-01-01');
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('404s for a key that is not there', async () => {
    stubStoredKey(NO_ROW);

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(404);
  });

  it('400s without a keyId', async () => {
    const result = await baseHandler(eventFor(OrgRole.Owner, NO_KEY_ID));

    expect(result.statusCode).toBe(400);
  });

  it('leaves the key alone when the org is being deleted', async () => {
    stubStoredKey();
    ddbMock
      .on(GetItemCommand, { Key: marshall({ pk: 'ORG#org-1', sk: 'PROFILE' }) })
      .resolves({ Item: marshall({ pk: 'ORG#org-1', deleting: true }) });

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(410);
    expect(mockEnsureTenantReady).not.toHaveBeenCalled();
    expect(mockIssueAccessKey).not.toHaveBeenCalled();
  });

  it('leaves the key alone when the vendor refuses the replacement', async () => {
    stubStoredKey();
    stubWrites();
    mockIssueAccessKey.mockRejectedValue(new AccessKeyValidationError('bad permissions'));

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(400);
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    expect(standaloneEvents().at(-1)).toMatchObject({ phase: 'completion', outcome: 'failed' });
  });

  it('leaves the key alone when the replacement collides with a name', async () => {
    stubStoredKey();
    stubWrites();
    mockIssueAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('takes the replacement back when its row does not land', async () => {
    stubStoredKey();
    ddbMock.on(PutItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...USER_INFO, role: OrgRole.Owner });
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}, {}, {}],
      }),
    );

    const result = await baseHandler(eventFor());

    // The creator-authority check is what refused, so the caller is told their
    // role changed rather than told to retry something that cannot succeed.
    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    // The replacement goes, and the key it was replacing is untouched.
    expect(mockDeleteAccessKey).toHaveBeenCalledTimes(1);
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
  });

  it('tells a caller to retry when the mint lost to contention', async () => {
    stubStoredKey();
    ddbMock.on(PutItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...USER_INFO, role: OrgRole.Owner });
    // A cancellation with no condition of ours in it: contention on the
    // sequence row, which a retry clears.
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{}, { Code: 'TransactionConflict' }, {}, {}],
      }),
    );

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBeUndefined();
    expect(body(result).message).toContain('try again');
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
  });

  it('discards the replacement when the caller was demoted mid-rotation', async () => {
    stubStoredKey();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    // The role on file when the post-write check reads it can no longer grant
    // a key at all.
    stubMembershipRead(ddbMock, { ...USER_INFO, role: OrgRole.ReadOnly });

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(mockDeleteAccessKey).toHaveBeenCalledWith(TENANT_ID, 'aurora-key-2');
  });

  it('hands over the replacement even when the old key survives its revoke', async () => {
    stubStoredKey();
    stubWrites();
    mockDeleteAccessKey.mockRejectedValue(new Error('vendor unavailable'));

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(201);
    expect(body(result)).toMatchObject({
      secretAccessKey: 'secret-abc-123',
      previousKeyRevoked: false,
    });
  });

  it('counts a revoked key as revoked when only its row survives', async () => {
    stubStoredKey();
    ddbMock.on(PutItemCommand).resolves({});
    stubMembershipRead(ddbMock, { ...USER_INFO, role: OrgRole.Owner });
    ddbMock
      .on(TransactWriteItemsCommand)
      .resolvesOnce({})
      .rejects(new RevocationNotRecordedError(KEY_ID));

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(201);
    expect(body(result).previousKeyRevoked).toBe(true);
  });

  it('rotates a row that records no bucket scope', async () => {
    // `marshall` throws on an undefined map value, and the throw would land
    // after the vendor had already minted the replacement — a live credential
    // with no row, which is the one outcome nothing can see.
    stubStoredKey({ bucketScope: undefined, buckets: undefined });
    stubWrites();

    const result = await baseHandler(eventFor());

    expect(result.statusCode).toBe(201);
    expect(replacementRow()).not.toHaveProperty('bucketScope');
  });
});
