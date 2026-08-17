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

import { handler } from './accept-invitation.js';
import { OrgKeys } from '../lib/org-membership.js';
import { hashInviteToken, inviteExpiresAt } from '../lib/invitations.js';
import { buildEvent, buildContext, NO_MEMBERSHIP } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|invitee';
/** The invitee's own org, which the session is authenticated into. */
const PERSONAL_ORG_ID = '11111111-1111-1111-1111-111111111111';
/** The org doing the inviting, which the caller is not a member of yet. */
const INVITING_ORG_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'invitee-user-id';
const INVITER_ID = 'inviter-user-id';
const INVITE_ID = '33333333-3333-3333-3333-333333333333';
const EMAIL = 'Invitee@Example.com';
const TOKEN = 'a-token-nobody-can-guess-0123456789';
const TOKEN_HASH = hashInviteToken(TOKEN);
const CREATED_AT = '2026-08-14T00:00:00.000Z';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function acceptEvent(body: unknown = { token: TOKEN }) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: {
      userId: USER_ID,
      orgId: PERSONAL_ORG_ID,
      email: EMAIL,
      // The real chain runs: the middleware resolves the session's own org and
      // membership, and the handler resolves the inviting org from the token.
      membership: NO_MEMBERSHIP,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/invitations/accept',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

interface InvitationOverrides {
  role?: OrgRole;
  status?: string;
  expiresAt?: string;
  emailNorm?: string;
}

function stubInvitation(overrides: InvitationOverrides = {}) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.inviteTokenPk(TOKEN_HASH) }, sk: { S: 'LOOKUP' } },
    })
    .resolves({ Item: { orgId: { S: INVITING_ORG_ID }, inviteId: { S: INVITE_ID } } });

  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
    })
    .resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
        sk: { S: OrgKeys.inviteSk(INVITE_ID) },
        email: { S: EMAIL },
        emailNorm: { S: overrides.emailNorm ?? EMAIL.toLowerCase() },
        role: { S: overrides.role ?? OrgRole.Member },
        invitedBy: { S: INVITER_ID },
        status: { S: overrides.status ?? 'pending' },
        createdAt: { S: CREATED_AT },
        expiresAt: { S: overrides.expiresAt ?? inviteExpiresAt(new Date().toISOString()) },
        tokenHash: { S: TOKEN_HASH },
      },
    });
}

/** No token lookup row at all — an unknown or already-redeemed token. */
function stubUnknownToken() {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.inviteTokenPk(TOKEN_HASH) }, sk: { S: 'LOOKUP' } },
    })
    .resolves({});
}

function stubMembershipInInvitingOrg(role?: OrgRole) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
    })
    .resolves(
      role
        ? {
            Item: {
              pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
              sk: { S: OrgKeys.memberSk(USER_ID) },
              role: { S: role },
              joinedAt: { S: CREATED_AT },
              source: { S: 'invitation' },
            },
          }
        : {},
    );
}

function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

function auditedEvent() {
  return unmarshall(auditItemIn(transactItems()));
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

/**
 * The reads authMiddleware makes before the handler runs — identity, the
 * caller's membership in their own org — plus the inviting org's profile.
 *
 * Its own helper because the uniform-not-found test resets the mock to describe
 * a second, unrelated request, and a session that stopped existing halfway
 * through would have that test passing on a 401.
 */
function stubSession() {
  // Every unstubbed read answers empty rather than undefined: `authMiddleware`
  // now reads the resolved org's profile on every request (the identity-provider
  // rule applies header or not), and a read that resolves to nothing at all
  // would surface as a 503 rather than as "this org has no SSO restriction".
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
        orgId: { S: PERSONAL_ORG_ID },
        emailEntitlementClaimed: { BOOL: true },
      },
    });
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(PERSONAL_ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
    })
    .resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(PERSONAL_ORG_ID) },
        sk: { S: OrgKeys.memberSk(USER_ID) },
        role: { S: OrgRole.Owner },
        joinedAt: { S: CREATED_AT },
      },
    });

  // The inviting org's profile, for the name the response carries.
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${INVITING_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({ Item: { name: { S: 'Acme Corp' } } });
}

function body(result: unknown) {
  return JSON.parse((result as { body: string }).body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/invitations/accept handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: true },
    });

    stubSession();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubInvitation();
    stubMembershipInInvitingOrg(undefined);
  });

  it('joins the org the invitation names', async () => {
    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result)).toStrictEqual({
      orgId: INVITING_ORG_ID,
      orgName: 'Acme Corp',
      role: OrgRole.Member,
      alreadyMember: false,
    });
  });

  it('writes the membership, its inverse item, and the invitation in one transaction', async () => {
    await handler(acceptEvent(), buildContext());

    const items = transactItems();
    // membership, inverse, inviter check, invitation status, token delete, event.
    expect(items).toHaveLength(6);

    const membership = items.find(
      (item) => item.Put?.Item?.sk?.S === OrgKeys.memberSk(USER_ID),
    )!.Put!;
    expect(membership).toMatchObject({
      TableName: 'OrgTable',
      Item: {
        pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
        role: { S: OrgRole.Member },
        source: { S: 'invitation' },
        invitedBy: { S: INVITER_ID },
      },
      // Two accepts of the same invitation: one lands, the other loses here.
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(items.some((item) => item.Put?.Item?.pk?.S === OrgKeys.userPk(USER_ID))).toBe(true);
  });

  it('marks the invitation accepted only while it is still pending', async () => {
    await handler(acceptEvent(), buildContext());

    const update = transactItems().find((item) => item.Update)!.Update!;
    expect(update).toMatchObject({
      Key: {
        pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
        sk: { S: OrgKeys.inviteSk(INVITE_ID) },
      },
      ConditionExpression: '#status = :pending',
      ExpressionAttributeValues: { ':status': { S: 'accepted' }, ':pending': { S: 'pending' } },
    });
  });

  it('spends the token by deleting its lookup row', async () => {
    // The delete, plus the pending condition above, is the whole single-use
    // guarantee — there is no "used" flag to read.
    await handler(acceptEvent(), buildContext());

    expect(
      transactItems().some((item) => item.Delete?.Key?.pk?.S === OrgKeys.inviteTokenPk(TOKEN_HASH)),
    ).toBe(true);
  });

  it('checks the inviter still holds a role that could have issued the invitation', async () => {
    await handler(acceptEvent(), buildContext());

    const check = transactItems().find((item) => item.ConditionCheck)!.ConditionCheck!;
    expect(check).toMatchObject({
      Key: {
        pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
        sk: { S: OrgKeys.memberSk(INVITER_ID) },
      },
      ConditionExpression: 'attribute_exists(pk) AND #role IN (:role0, :role1)',
      ExpressionAttributeValues: { ':role0': { S: OrgRole.Owner }, ':role1': { S: OrgRole.Admin } },
    });
  });

  it('records the acceptance beside the write, carrying no token', async () => {
    await handler(acceptEvent(), buildContext());

    const event = auditedEvent();
    expect(event).toMatchObject({
      type: 'invite.accepted',
      orgId: INVITING_ORG_ID,
      subject: `invite:${INVITE_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { inviteId: INVITE_ID, email: EMAIL, role: OrgRole.Member },
    });
    expectNoSecrets(auditItemIn(transactItems()));

    const written = JSON.stringify(transactItems());
    expect(written).not.toContain(TOKEN);
    expect(written).toContain(TOKEN_HASH);
  });

  it('raises the owner count when the invitation was to Owner', async () => {
    stubInvitation({ role: OrgRole.Owner });

    await handler(acceptEvent(), buildContext());

    const counter = transactItems().find((item) => item.Update?.Key?.sk?.S === 'META')!.Update!;
    expect(counter).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: 'META' } },
      UpdateExpression: 'SET ownerCount = ownerCount + :one',
      ConditionExpression: 'attribute_exists(ownerCount)',
    });
  });

  it('leaves the counter alone for every other role', async () => {
    await handler(acceptEvent(), buildContext());

    expect(transactItems().some((item) => item.Update?.Key?.sk?.S === 'META')).toBe(false);
  });

  it.each([
    ['an expired invitation', { expiresAt: '2026-07-01T00:00:00.000Z' } as InvitationOverrides],
    ['a revoked invitation', { status: 'revoked' } as InvitationOverrides],
    ['an already accepted invitation', { status: 'accepted' } as InvitationOverrides],
  ])('answers %s exactly as it answers an unknown token', async (_label, overrides) => {
    stubInvitation(overrides);
    const known = await handler(acceptEvent(), buildContext());

    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubSession();
    stubUnknownToken();
    const unknown = await handler(acceptEvent(), buildContext());

    // Same status and same body: telling the four apart would describe other
    // people's invitations to whoever holds a stale link.
    expect(known).toMatchObject({ statusCode: 404 });
    expect(body(known)).toStrictEqual(body(unknown));
    expect(body(known).code).toBe(ApiErrorCode.INVITE_NOT_FOUND);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses a session whose verified email is not the invited address', async () => {
    // The token alone must not admit whoever a forwarded email reaches.
    stubInvitation({ emailNorm: 'someone.else@example.com' });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_EMAIL_MISMATCH);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('matches the invited address regardless of case', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: 'INVITEE@EXAMPLE.COM', email_verified: true },
    });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('refuses a session whose email is not verified, in the chain', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: false },
    });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    // Which layer refused matters: this is the shared verification gate, not the
    // handler's address comparison, and the console's remedy for the two is
    // different — verify your address, versus sign in as somebody else.
    expect(body(result).code).toBe(ApiErrorCode.EMAIL_NOT_VERIFIED);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses a verified session that carries no address at all', async () => {
    // `email_verified` with no `email` reaches the handler, so the handler's own
    // branch is what refuses it — there is nothing to compare the invitation to.
    mockJwtVerify.mockResolvedValue({ payload: { sub: MOCK_SUB, email_verified: true } });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_EMAIL_MISMATCH);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('is idempotent for somebody who is already a member', async () => {
    stubMembershipInInvitingOrg(OrgRole.Admin);
    stubInvitation({ role: OrgRole.Member });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    // The invitation is still marked accepted, and the role they already hold is
    // the role they keep: accepting is not a way to grant a change nobody asked
    // for.
    expect(body(result)).toMatchObject({ alreadyMember: true, role: OrgRole.Admin });
    const items = transactItems();
    expect(items).toHaveLength(3);
    expect(items.some((item) => item.Put?.Item?.sk?.S === OrgKeys.memberSk(USER_ID))).toBe(false);
  });

  it('keeps the role a member already holds even when the invitation offers more', async () => {
    // The direction that matters: an Owner invitation redeemed by somebody who
    // is already a Member must not promote them, and the counter must not move.
    stubMembershipInInvitingOrg(OrgRole.Member);
    stubInvitation({ role: OrgRole.Owner });

    const result = await handler(acceptEvent(), buildContext());

    expect(body(result)).toMatchObject({ alreadyMember: true, role: OrgRole.Member });
    expect(transactItems().some((item) => item.Update?.Key?.sk?.S === 'META')).toBe(false);
  });

  it('says in the log when an accept granted nothing', async () => {
    stubMembershipInInvitingOrg(OrgRole.Admin);

    await handler(acceptEvent(), buildContext());

    // Two shapes of success reach this event — one that added a member and one
    // that only spent an invitation — and without the marker they read alike.
    expect(auditedEvent().details).toMatchObject({ alreadyMember: true });
  });

  it('leaves the marker off an accept that did add the member', async () => {
    await handler(acceptEvent(), buildContext());

    expect(auditedEvent().details).not.toHaveProperty('alreadyMember');
  });

  it('answers success when the membership appeared while the request was in flight', async () => {
    // Two clicks on the same link. The create-only condition loses, and the
    // loser must not be told their invitation failed.
    ddbMock.on(TransactWriteItemsCommand).rejectsOnce(cancelledAt(0, 6)).resolves({});
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
      })
      .resolvesOnce({})
      .resolves({
        Item: {
          pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
          sk: { S: OrgKeys.memberSk(USER_ID) },
          role: { S: OrgRole.Member },
          joinedAt: { S: CREATED_AT },
        },
      });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result)).toMatchObject({ alreadyMember: true, role: OrgRole.Member });
  });

  it('still retires the invitation when the join lost that race', async () => {
    // The whole transaction cancelled, so nothing marked the invitation — and a
    // link the caller has already used would stay live for a fortnight.
    ddbMock.on(TransactWriteItemsCommand).rejectsOnce(cancelledAt(0, 6)).resolves({});
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
      })
      .resolvesOnce({})
      .resolves({
        Item: {
          pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
          sk: { S: OrgKeys.memberSk(USER_ID) },
          role: { S: OrgRole.Member },
          joinedAt: { S: CREATED_AT },
        },
      });

    await handler(acceptEvent(), buildContext());

    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(2);
    const retry = calls[1].args[0].input.TransactItems ?? [];
    // The status update, the token delete, and the event — nothing else: the
    // membership already exists.
    expect(retry).toHaveLength(3);
    expect(retry[0].Update).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
      ConditionExpression: '#status = :pending',
      ExpressionAttributeValues: { ':status': { S: 'accepted' }, ':pending': { S: 'pending' } },
    });
    expect(retry[1].Delete?.Key?.pk?.S).toBe(OrgKeys.inviteTokenPk(TOKEN_HASH));
    expect(unmarshall(auditItemIn(retry)).details).toMatchObject({ alreadyMember: true });
  });

  it('answers the member success even when that retirement cannot land', async () => {
    // A revoke that won the race cancels the second transaction too. The caller
    // is a member of the org, which is what they asked for; the bookkeeping
    // failure is logged rather than answered.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 6));
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
      })
      .resolvesOnce({})
      .resolves({
        Item: {
          pk: { S: OrgKeys.orgPk(INVITING_ORG_ID) },
          sk: { S: OrgKeys.memberSk(USER_ID) },
          role: { S: OrgRole.Member },
          joinedAt: { S: CREATED_AT },
        },
      });

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses when the inviter no longer holds the authority they invited with', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 6));

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).message).toStrictEqual(
      expect.stringContaining('no longer has permission to add members'),
    );
  });

  it('answers not-found when the invitation was revoked mid-flight', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(3, 6));

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(body(result).code).toBe(ApiErrorCode.INVITE_NOT_FOUND);
  });

  it('refuses an Owner invitation into an org whose counter is missing', async () => {
    stubInvitation({ role: OrgRole.Owner });
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(3, 7));

    const result = await handler(acceptEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(console.error).toHaveBeenCalled();
  });

  it('touches no billing or entitlement row', async () => {
    // The three §4 guarantees rest on this: joining someone else's org creates
    // no trial, reads no EMAIL_NORM# suppression record, and leaves the
    // invitee's own claim unspent.
    await handler(acceptEvent(), buildContext());

    const everyCall = JSON.stringify([
      ...ddbMock.commandCalls(GetItemCommand).map((call) => call.args[0].input),
      ...ddbMock.commandCalls(TransactWriteItemsCommand).map((call) => call.args[0].input),
    ]);
    expect(everyCall).not.toContain('BillingTable');
    expect(everyCall).not.toContain('EMAIL_NORM#');
  });

  it.each([
    ['a body with no token', {}],
    ['a token too short to be one', { token: 'short' }],
    ['invalid JSON', 'not-json{'],
  ])('returns 400 for %s', async (_label, payload) => {
    const result = await handler(acceptEvent(payload), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });
});
