import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole, S3Region } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockGetMfaEnrollments = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getMfaEnrollments: (sub: string) => mockGetMfaEnrollments(sub),
}));

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

// The transfer revokes the outgoing Owner's keys at whichever orchestrator
// holds them, and the registry builds the FTH client at import time from a
// secret this suite has no reason to stand up.
const mockDeleteAccessKey = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => ({
    id: region === 'us-east-1' ? 'fth' : 'aurora',
    region,
    accessModel: 'scoped-keys',
    isTenantReady: () => `tenant:${region}`,
    deleteAccessKey: (...args: unknown[]) => mockDeleteAccessKey(...args),
  }),
}));

const ddbMock = mockClient(DynamoDBClient);

// The revocation email is the only thing here that leaves over HTTP.
const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './transfer-ownership.js';
import { OrgKeys } from '../lib/org-membership.js';
import { inviteExpiresAt } from '../lib/invitations.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

const MOCK_SUB = 'auth0|owner';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'caller-user-id';
const TARGET_ID = 'target-user-id';
const EMAIL = 'owner@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

/**
 * A session that satisfied an MFA challenge, recently. Both halves are required:
 * `amr` says what kind of authentication happened and `auth_time` says when, and
 * an MFA sign-in from this morning is a fact about the session rather than proof
 * about whoever is at the keyboard now.
 */
function withMfa(secondsAgo = 30) {
  mockJwtVerify.mockResolvedValue({
    payload: {
      sub: MOCK_SUB,
      email: EMAIL,
      email_verified: true,
      amr: ['pwd', 'mfa'],
      auth_time: Math.floor(Date.now() / 1000) - secondsAgo,
    },
  });
}

/** A session that authenticated `secondsAgo` and asserted no MFA. */
function withFreshLogin(secondsAgo: number) {
  mockJwtVerify.mockResolvedValue({
    payload: {
      sub: MOCK_SUB,
      email: EMAIL,
      email_verified: true,
      amr: ['pwd'],
      auth_time: Math.floor(Date.now() / 1000) - secondsAgo,
    },
  });
}

function transferEvent(body: unknown = { userId: TARGET_ID }) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/org/transfer',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role });
}

function targetHolds(role: OrgRole | undefined) {
  if (!role) {
    stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET_ID });
    return;
  }
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET_ID, role });
}

/** The outgoing Owner's pending invitations, which the transfer sweeps. */
function invitationRow({
  inviteId,
  role,
  invitedBy = USER_ID,
}: {
  inviteId: string;
  role: OrgRole;
  invitedBy?: string;
}) {
  return {
    pk: { S: OrgKeys.orgPk(ORG_ID) },
    sk: { S: OrgKeys.inviteSk(inviteId) },
    email: { S: `${inviteId}@example.com` },
    emailNorm: { S: `${inviteId}@example.com` },
    role: { S: role },
    invitedBy: { S: invitedBy },
    status: { S: 'pending' },
    createdAt: { S: '2026-08-14T00:00:00.000Z' },
    expiresAt: { S: inviteExpiresAt(new Date().toISOString()) },
    tokenHash: { S: inviteId.padEnd(64, '0').slice(0, 64) },
  };
}

function stubInvitationRows(items: Record<string, { S: string }>[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
    })
    .resolves({ Items: items });
}

/**
 * The org's META row. The transfer bumps `ownerCount` by nothing, and that
 * update conditions on the attribute existing, so a counter that cannot be read
 * refuses the transfer before anything is revoked.
 */
function stubOwnerCount(ownerCount: number | undefined) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: 'META' } },
    })
    .resolves(
      ownerCount === undefined
        ? {}
        : {
            Item: {
              pk: { S: OrgKeys.orgPk(ORG_ID) },
              sk: { S: 'META' },
              ownerCount: { N: String(ownerCount) },
            },
          },
    );
}

/** The outgoing Owner's access keys, as the org partition holds them. */
function stubMemberKeys(...keys: Array<Record<string, unknown>>) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'UserInfoTable',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${ORG_ID}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    })
    .resolves({
      Items: keys.map((key, index) =>
        marshall(
          {
            pk: `ORG#${ORG_ID}`,
            sk: `ACCESSKEY#key-${index}`,
            keyName: `key ${index}`,
            accessKeyId: `AKIAEXAMPLE000${index}`,
            createdAt: '2026-02-01T00:00:00.000Z',
            status: 'active',
            region: S3Region.UsEast1,
            createdBy: USER_ID,
            permissions: ['read', 'write'],
            ...key,
          },
          { removeUndefinedValues: true },
        ),
      ),
    });
}

function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

function body(result: unknown) {
  return JSON.parse((result as { body: string }).body);
}

/** The cancellation DynamoDB sends when one item's condition fails. */
function cancelledAt(index: number, itemCount: number) {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: Array.from({ length: itemCount }, (_unused, position) => ({
      Code: position === index ? 'ConditionalCheckFailed' : 'None',
    })),
  });
}

describe('POST /api/org/transfer handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    withMfa();
    mockGetMfaEnrollments.mockResolvedValue([]);

    ddbMock.on(GetItemCommand).resolves({});
    // The org partition the revocation pass reads. Most cases hold no keys.
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    stubOwnerCount(1);
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: USER_ID },
          orgId: { S: ORG_ID },
        },
      });

    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubInvitationRows([]);
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Admin);
  });

  it('moves the seat even when the pass after it cannot finish', async () => {
    // The transaction has committed by then: the target is Owner and the caller
    // is Admin. An error would send them into a retry that answers already-owner.
    stubMemberKeys({ granularPermissions: ['PutObjectRetention'] });
    ddbMock
      .on(QueryCommand, {
        TableName: 'UserInfoTable',
        ExpressionAttributeValues: {
          ':pk': { S: `ORG#${ORG_ID}` },
          ':skPrefix': { S: 'ACCESSKEY#' },
        },
      })
      .resolvesOnce({
        Items: [
          marshall({
            pk: `ORG#${ORG_ID}`,
            sk: 'ACCESSKEY#key-0',
            keyName: 'key 0',
            accessKeyId: 'AKIAEXAMPLE0000',
            createdAt: '2026-02-01T00:00:00.000Z',
            status: 'active',
            region: S3Region.UsEast1,
            createdBy: USER_ID,
            permissions: ['write'],
            granularPermissions: ['PutObjectRetention'],
          }),
        ],
      })
      .rejects(new Error('DynamoDB unavailable'));

    expect(await handler(transferEvent(), buildContext())).toMatchObject({ statusCode: 200 });
  });

  it('names the keys already revoked when a vendor refuses a later one', async () => {
    stubMemberKeys(
      { granularPermissions: ['PutObjectRetention'] },
      { granularPermissions: ['PutObjectLegalHold'] },
    );
    mockDeleteAccessKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 502 });
    expect(body(result).revokedKeys.map((key: { id: string }) => key.id)).toStrictEqual(['key-0']);
  });

  it('refuses a transfer with no counter to read, before a key is touched', async () => {
    // The transaction bumps `ownerCount` by nothing, and that update conditions
    // on the attribute existing, so a missing META row cancels the transfer
    // either way. Revoking first would leave the caller Owner with their
    // credentials gone.
    stubOwnerCount(undefined);
    stubMemberKeys({ granularPermissions: ['PutObjectRetention'] });

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).message).toContain('owner count');
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('promotes the target and demotes the caller in one transaction', async () => {
    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result)).toStrictEqual({ userId: TARGET_ID, previousOwnerUserId: USER_ID });

    const items = transactItems();
    // The fence, two rows each for the promotion and the demotion, the counter,
    // the event.
    expect(items).toHaveLength(7);
    expect(
      items.find((item) => item.Update?.Key?.sk?.S === OrgKeys.memberSk(TARGET_ID))!.Update,
    ).toMatchObject({
      ExpressionAttributeValues: {
        ':role': { S: OrgRole.Owner },
        ':fromRole': { S: OrgRole.Admin },
      },
      ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
    });
    expect(
      items.find((item) => item.Update?.Key?.sk?.S === OrgKeys.memberSk(USER_ID))!.Update,
    ).toMatchObject({
      // The outgoing Owner stays as an Admin: handing over the seat is not
      // leaving the org.
      ExpressionAttributeValues: {
        ':role': { S: OrgRole.Admin },
        ':fromRole': { S: OrgRole.Owner },
      },
    });
  });

  it('touches the owner count exactly once, by nothing', async () => {
    await handler(transferEvent(), buildContext());

    const counters = transactItems().filter((item) => item.Update?.Key?.sk?.S === 'META');
    // DynamoDB permits one operation per item per transaction, so a promotion
    // and a demotion cannot each carry their own delta.
    expect(counters).toHaveLength(1);
    expect(counters[0].Update).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount + :zero ADD ownerSetRev :one',
      ConditionExpression: 'attribute_exists(ownerCount)',
      ExpressionAttributeValues: { ':zero': { N: '0' } },
    });
  });

  it('records the transfer with no secret in it', async () => {
    await handler(transferEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems()))).toMatchObject({
      type: 'ownership.transferred',
      orgId: ORG_ID,
      subject: `org:${ORG_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { fromUserId: USER_ID, toUserId: TARGET_ID },
    });
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('revokes the outgoing Owner’s pending Owner invitations, in the same transaction', async () => {
    // They leave as an Admin, and an Admin can neither issue an Owner
    // invitation nor keep one outstanding. The accept path already refuses
    // those links, so this is what stops dead links, occupied cap slots, and
    // pending rows nobody can explain.
    stubInvitationRows([
      invitationRow({ inviteId: 'theirs-owner', role: OrgRole.Owner }),
      invitationRow({ inviteId: 'theirs-admin', role: OrgRole.Admin }),
      invitationRow({ inviteId: 'somebody-elses', role: OrgRole.Owner, invitedBy: TARGET_ID }),
    ]);

    await handler(transferEvent(), buildContext());

    const items = transactItems();
    const revoked = items.filter(
      (item) => item.Update?.UpdateExpression === 'SET #status = :status',
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0].Update?.Key?.sk?.S).toBe(OrgKeys.inviteSk('theirs-owner'));
    // What an Admin could have issued stays: the demotion does not reach it.
    expect(JSON.stringify(items)).not.toContain('theirs-admin');
    expect(JSON.stringify(items)).not.toContain('somebody-elses');
    expect(unmarshall(auditItemIn(items)).details).toMatchObject({ revokedInvitations: 1 });
  });

  it('says nothing about revocations when there were none', async () => {
    await handler(transferEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems())).details).not.toHaveProperty(
      'revokedInvitations',
    );
  });

  it('returns 404 for somebody who is not a member', async () => {
    targetHolds(undefined);

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 409 when the target already owns the org', async () => {
    targetHolds(OrgRole.Owner);

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 409 for a transfer to yourself', async () => {
    const result = await handler(transferEvent({ userId: USER_ID }), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('loses cleanly when the roles moved under it', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(1, 7));

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('fences the transaction on the org not being deleted, as item 0', async () => {
    // Both role changes write an inverse item unconditionally, so a transfer
    // landing after the scrub deleted those items would recreate two of them in
    // a partition the teardown has already walked past.
    await handler(transferEvent(), buildContext());

    expect(transactItems()[0].ConditionCheck).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
    });
  });

  it('answers account-deleted when the org is being torn down', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 7));

    const result = await handler(transferEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 410 });
    expect(body(result).code).toBe(ApiErrorCode.ACCOUNT_DELETED);
  });

  it('returns 400 for a body naming nobody', async () => {
    const result = await handler(transferEvent({}), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  describe('step-up', () => {
    it('accepts a session that satisfied an MFA challenge, asking Auth0 nothing', async () => {
      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 200 });
      expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
    });

    it('refuses a session that is neither strong nor fresh', async () => {
      withFreshLogin(3600);

      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 401 });
      expect(body(result)).toStrictEqual({ error: 'step_up_required' });
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    });

    it('refuses an MFA session that is no longer fresh', async () => {
      // The gate is a step-up, not a session attribute: this is the only verb
      // that takes the caller's own authority away, and an MFA challenge
      // satisfied hours ago says nothing about who is at the keyboard now. The
      // remedy is one redirect — `max_age=0` forces a fresh authentication.
      withMfa(3600);

      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 401 });
      expect(body(result)).toStrictEqual({ error: 'step_up_required' });
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    });

    it('accepts a fresh sign-in from a user with nothing enrolled', async () => {
      // The SAML and no-MFA case: `amr` will never carry `mfa`, and a gate that
      // demanded it would deny outright rather than prompt.
      withFreshLogin(30);
      mockGetMfaEnrollments.mockResolvedValue([]);

      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 200 });
    });

    it('refuses a fresh sign-in from a user who has MFA enrolled', async () => {
      // They can satisfy the real challenge, so the fresh password login is not
      // the step-up they owe.
      withFreshLogin(30);
      mockGetMfaEnrollments.mockResolvedValue([{ id: 'enrollment-1', type: 'totp' }]);

      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 401 });
    });

    it('accepts a fresh sign-in when the enrollment read fails', async () => {
      // Denying would loop a user with no MFA through a redirect that cannot
      // satisfy a check we are unable to make.
      withFreshLogin(30);
      mockGetMfaEnrollments.mockRejectedValue(new Error('Auth0 unavailable'));

      const result = await handler(transferEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 200 });
      expect(console.error).toHaveBeenCalled();
    });
  });
});
