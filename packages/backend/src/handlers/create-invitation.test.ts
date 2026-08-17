import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, MAX_PENDING_INVITATIONS_PER_ORG, OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
process.env.WEBSITE_URL = 'https://app.example.com';
// Anything but staging or production: the stage-selected mailer logs the accept
// URL instead of sending, which is what the e2e suite drives.
process.env.FILONE_STAGE = 'dev-test';

import { handler } from './create-invitation.js';
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|inviter';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'inviter-user-id';
const INVITER_EMAIL = 'inviter@example.com';
const INVITED_EMAIL = 'Invitee@Example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function inviteEvent(body: unknown = { email: INVITED_EMAIL, role: OrgRole.Member }) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: {
      userId: USER_ID,
      orgId: ORG_ID,
      email: INVITER_EMAIL,
      name: 'Inviting Person',
      // The real chain runs and reads the role off the membership row.
      membership: NO_MEMBERSHIP,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/org/invitations',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role });
}

/** The beta flag, as either of the two rows that grant it. */
function grantBeta(pk: string) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } },
    })
    .resolves({ Item: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } } });
}

/** The org's existing invitation rows, which the cap is computed from. */
function stubPendingInvitations(count: number, status = 'pending') {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
    })
    .resolves({
      Items: Array.from({ length: count }, (_unused, index) => ({
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.inviteSk(`invite-${index}`) },
        email: { S: `person-${index}@example.com` },
        emailNorm: { S: `person-${index}@example.com` },
        role: { S: OrgRole.Member },
        invitedBy: { S: USER_ID },
        status: { S: status },
        createdAt: { S: '2026-08-14T00:00:00.000Z' },
        expiresAt: { S: inviteExpiresAt(new Date().toISOString()) },
        tokenHash: { S: 'b'.repeat(64) },
      })),
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

/** The accept URL the no-op mailer logged, which is where the token lives. */
function loggedAcceptUrl(): string {
  const logged = vi.mocked(console.log).mock.calls.flat();
  const entry = logged.find(
    (value): value is { acceptUrl: string } =>
      typeof value === 'object' && value !== null && 'acceptUrl' in value,
  );
  expect(entry, 'the dev-stage mailer logs the accept URL').toBeDefined();
  return entry!.acceptUrl;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/org/invitations handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: INVITER_EMAIL, email_verified: true },
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
          emailEntitlementClaimed: { BOOL: true },
        },
      });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Acme Corp' } } });

    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubPendingInvitations(0);
    grantBeta(`ALLOWLIST#${INVITER_EMAIL}`);
    callerHolds(OrgRole.Owner);
  });

  it('creates the invitation and reports whether the email went out', async () => {
    const result = await handler(inviteEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 201 });
    expect(body(result).invitation).toMatchObject({
      email: INVITED_EMAIL,
      role: OrgRole.Member,
      invitedBy: USER_ID,
      status: 'pending',
      expired: false,
    });
    // Fourteen days, from the ADR — expiry is a read-time check, not a TTL.
    const { createdAt, expiresAt } = body(result).invitation;
    expect(Date.parse(expiresAt) - Date.parse(createdAt)).toBe(14 * 24 * 60 * 60 * 1000);
    // The dev stage sends nothing, and the response says so rather than
    // claiming a delivery we did not make.
    expect(body(result).emailSent).toBe(false);
  });

  it('writes the invitation, its token lookup, and the event in one transaction', async () => {
    await handler(inviteEvent(), buildContext());

    const items = transactItems();
    expect(items).toHaveLength(3);

    const invitation = items.find((item) => item.Put?.Item?.sk?.S?.startsWith('INVITE#'))!.Put!;
    expect(invitation).toMatchObject({
      TableName: 'OrgTable',
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        email: { S: INVITED_EMAIL },
        emailNorm: { S: 'invitee@example.com' },
        role: { S: OrgRole.Member },
        status: { S: 'pending' },
        invitedBy: { S: USER_ID },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });

    const lookup = items.find((item) => item.Put?.Item?.pk?.S?.startsWith('INVITETOKEN#'))!.Put!;
    expect(lookup).toMatchObject({
      Item: { sk: { S: 'LOOKUP' }, orgId: { S: ORG_ID } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('stores the token’s digest and never the token itself', async () => {
    await handler(inviteEvent(), buildContext());

    const token = new URL(loggedAcceptUrl()).searchParams.get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const written = JSON.stringify(transactItems());
    expect(written).not.toContain(token);
    expect(written).not.toContain(loggedAcceptUrl());
    // What the row does carry: a 64-character hex digest.
    const stored = transactItems().find((item) => item.Put?.Item?.tokenHash)!.Put!;
    expect(stored.Item!.tokenHash!.S).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the invitation in the audit log, with no secret in it', async () => {
    await handler(inviteEvent(), buildContext());

    const event = unmarshall(auditItemIn(transactItems()));
    expect(event).toMatchObject({
      type: 'member.invited',
      orgId: ORG_ID,
      actor: { kind: 'user', id: USER_ID, email: INVITER_EMAIL },
      details: { email: INVITED_EMAIL, role: OrgRole.Member },
    });
    expect(event.subject).toBe(`invite:${event.details.inviteId}`);
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('refuses an Admin inviting an Owner, and lets an Owner do it', async () => {
    callerHolds(OrgRole.Admin);
    const denied = await handler(
      inviteEvent({ email: INVITED_EMAIL, role: OrgRole.Owner }),
      buildContext(),
    );

    expect(denied).toMatchObject({ statusCode: 403 });
    expect(body(denied).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);

    callerHolds(OrgRole.Owner);
    const allowed = await handler(
      inviteEvent({ email: INVITED_EMAIL, role: OrgRole.Owner }),
      buildContext(),
    );

    expect(allowed).toMatchObject({ statusCode: 201 });
  });

  it('lets an Admin invite up to Admin', async () => {
    callerHolds(OrgRole.Admin);

    const result = await handler(
      inviteEvent({ email: INVITED_EMAIL, role: OrgRole.Admin }),
      buildContext(),
    );

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('refuses when neither beta row exists', async () => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    stubPendingInvitations(0);
    callerHolds(OrgRole.Owner);

    const result = await handler(inviteEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    // A message the console renders as-is: this is the feature not being on for
    // them, not their role refusing them.
    expect(body(result).code).toBeUndefined();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('accepts the org’s own beta row, for a caller with no allowlist row', async () => {
    grantBeta(`ORG#${ORG_ID}`);

    const result = await handler(inviteEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('refuses once the org holds as many pending invitations as it may', async () => {
    stubPendingInvitations(MAX_PENDING_INVITATIONS_PER_ORG);

    const result = await handler(inviteEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_LIMIT_REACHED);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it.each(['revoked', 'accepted'])(
    'does not count %s invitations against the cap',
    async (status) => {
      stubPendingInvitations(MAX_PENDING_INVITATIONS_PER_ORG, status);

      const result = await handler(inviteEvent(), buildContext());

      expect(result).toMatchObject({ statusCode: 201 });
    },
  );

  it('sends nothing on a stage with no SendGrid secret, and still creates the invitation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await handler(inviteEvent(), buildContext());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusCode: 201 });
    expect(loggedAcceptUrl()).toContain('https://app.example.com/invite/accept?token=');
  });

  it.each([
    ['no email', { role: OrgRole.Member }],
    ['an address that is not one', { email: 'not-an-email', role: OrgRole.Member }],
    ['a role that is not one of the four', { email: INVITED_EMAIL, role: 'billing' }],
    ['invalid JSON', 'not-json{'],
  ])('returns 400 for %s', async (_label, payload) => {
    const result = await handler(inviteEvent(payload), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  describeRoleEnforcement({
    permission: 'members.manage',
    orgId: ORG_ID,
    userId: USER_ID,
    invoke: (membership) => {
      if (membership === NO_MEMBERSHIP) {
        stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID });
      } else {
        callerHolds(membership.role);
      }
      return handler(inviteEvent(), buildContext());
    },
  });
});
