import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './revoke-invitation.js';
import { OrgKeys } from '../lib/org-membership.js';
import { inviteExpiresAt } from '../lib/invitations.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

const MOCK_SUB = 'auth0|admin';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'admin-user-id';
const EMAIL = 'admin@example.com';
const INVITE_ID = '99999999-8888-7777-6666-555555555555';
const INVITED_EMAIL = 'invitee@example.com';
const TOKEN_HASH = 'd'.repeat(64);
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function revokeEvent(inviteId: string | null = INVITE_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'DELETE',
    rawPath: `/api/org/invitations/${inviteId ?? ''}`,
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  if (inviteId) {
    (event as { pathParameters?: Record<string, string> }).pathParameters = { inviteId };
  }
  return event;
}

function stubInvitation(overrides: { status?: string; role?: OrgRole; expiresAt?: string } = {}) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
    })
    .resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.inviteSk(INVITE_ID) },
        email: { S: INVITED_EMAIL },
        emailNorm: { S: INVITED_EMAIL },
        role: { S: overrides.role ?? OrgRole.Member },
        invitedBy: { S: 'somebody-else' },
        status: { S: overrides.status ?? 'pending' },
        createdAt: { S: '2026-08-14T00:00:00.000Z' },
        expiresAt: { S: overrides.expiresAt ?? inviteExpiresAt(new Date().toISOString()) },
        tokenHash: { S: TOKEN_HASH },
      },
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

describe('DELETE /api/org/invitations/{inviteId} handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: true },
    });

    ddbMock.on(GetItemCommand).resolves({});
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
    stubInvitation();
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner });
  });

  it('revokes the invitation and drops its token', async () => {
    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
    const items = transactItems();
    expect(items).toHaveLength(3);

    expect(items.find((item) => item.Update)!.Update).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
      // The condition that resolves a revoke racing an accept.
      ConditionExpression: '#status = :pending',
      ExpressionAttributeValues: { ':status': { S: 'revoked' }, ':pending': { S: 'pending' } },
    });
    expect(items.find((item) => item.Delete)!.Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.inviteTokenPk(TOKEN_HASH) }, sk: { S: 'LOOKUP' } },
    });
  });

  it('records the revocation with no secret in it', async () => {
    await handler(revokeEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems()))).toMatchObject({
      type: 'invite.revoked',
      orgId: ORG_ID,
      subject: `invite:${INVITE_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { inviteId: INVITE_ID, email: INVITED_EMAIL },
    });
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('refuses an Admin revoking an Owner invitation', async () => {
    // The ceiling is on the invitation's role, not on who issued it: an Admin
    // cannot revoke what they could not have sent.
    stubInvitation({ role: OrgRole.Owner });
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Admin });

    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('lets an Owner revoke an Owner invitation', async () => {
    stubInvitation({ role: OrgRole.Owner });

    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
  });

  it.each([
    ['one that was already accepted', { status: 'accepted' }],
    ['one that was already revoked', { status: 'revoked' }],
  ])('answers %s the way it answers an unknown id', async (_label, overrides) => {
    stubInvitation(overrides);

    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_NOT_FOUND);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 404 for an invitation that does not exist', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
      })
      .resolves({});

    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('still revokes an expired invitation', async () => {
    // The row is what the console is trying to clear off the page.
    stubInvitation({ expiresAt: '2026-07-01T00:00:00.000Z' });

    const result = await handler(revokeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
  });

  it('loses cleanly to an accept that landed first', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );

    const result = await handler(revokeEvent(), buildContext());

    // A 409, never a 500, and never a log claiming the invitation was revoked
    // after it was used.
    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_NOT_FOUND);
  });

  it('returns 400 with no invitation id in the path', async () => {
    const result = await handler(revokeEvent(null), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  describeRoleEnforcement({
    permission: 'members.manage',
    orgId: ORG_ID,
    userId: USER_ID,
    invoke: (membership) => {
      if (membership === NO_MEMBERSHIP) {
        stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID });
      } else {
        stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: membership.role });
      }
      return handler(revokeEvent(), buildContext());
    },
  });
});
