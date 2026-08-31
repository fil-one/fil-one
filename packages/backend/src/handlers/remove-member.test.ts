import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
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

import { handler } from './remove-member.js';
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
const TARGET_EMAIL = 'Departing.Person@Example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function removeEvent(targetUserId: string | null = TARGET_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'DELETE',
    rawPath: `/api/org/members/${targetUserId ?? ''}`,
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  if (targetUserId) {
    (event as { pathParameters?: Record<string, string> }).pathParameters = {
      userId: targetUserId,
    };
  }
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role });
}

function targetHolds(role: OrgRole | undefined, userId = TARGET_ID) {
  if (!role) {
    stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId });
    return;
  }
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId, role });
}

/**
 * A Member when the handler reads the row, and something else by the time the
 * failure path looks again — which is the only thing that can tell a removal
 * somebody else already made from a role that changed underneath it.
 */
function targetOnSecondRead(role: OrgRole | undefined) {
  const key = { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(TARGET_ID) } };
  const row = (held: OrgRole) => ({ Item: { ...key, role: { S: held } } });

  ddbMock
    .on(GetItemCommand, { TableName: 'OrgTable', Key: key })
    .resolvesOnce(row(OrgRole.Member))
    .resolves(role ? row(role) : {});
}

function invitationRow({
  inviteId,
  emailNorm,
  invitedBy = TARGET_ID,
  role = OrgRole.Member,
}: {
  inviteId: string;
  emailNorm: string;
  invitedBy?: string;
  role?: OrgRole;
}) {
  return {
    pk: { S: OrgKeys.orgPk(ORG_ID) },
    sk: { S: OrgKeys.inviteSk(inviteId) },
    email: { S: emailNorm },
    emailNorm: { S: emailNorm },
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

/** `count` invitations the target issued to other people. */
function stubTargetInvitations(count: number) {
  stubInvitationRows(
    Array.from({ length: count }, (_unused, index) =>
      invitationRow({ inviteId: `invite-${index}`, emailNorm: `person-${index}@example.com` }),
    ),
  );
}

/**
 * The org's META row, which the failure path reads to tell the last-Owner guard
 * firing from there being no counter for it to fire on.
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

/** The `USER#{userId}/PROFILE` row, which is where a member's address lives. */
function stubTargetProfile(email: string | undefined, userId = TARGET_ID) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves(email ? { Item: { email: { S: email } } } : {});
}

function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

function body(result: unknown) {
  return JSON.parse((result as { body: string }).body);
}

function cancelledAt(index: number, itemCount: number) {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: Array.from({ length: itemCount }, (_unused, position) => ({
      Code: position === index ? 'ConditionalCheckFailed' : 'None',
    })),
  });
}

describe('DELETE /api/org/members/{userId} handler', () => {
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
    stubTargetInvitations(0);
    stubTargetProfile(TARGET_EMAIL);
    stubOwnerCount(1);
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Member);
  });

  it('removes both membership rows', async () => {
    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
    const items = transactItems();
    expect(items).toHaveLength(3);
    expect(items[0].Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(TARGET_ID) } },
      // Removing somebody already gone is a clean 404, not a silent success; the
      // role is there because the transaction's owner-count delta was decided
      // from the reading above.
      ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
      ExpressionAttributeValues: { ':fromRole': { S: OrgRole.Member } },
    });
    expect(items[1].Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.userPk(TARGET_ID) }, sk: { S: OrgKeys.membershipSk(ORG_ID) } },
    });
  });

  it('records the removal with no secret in it', async () => {
    await handler(removeEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems()))).toMatchObject({
      type: 'member.removed',
      orgId: ORG_ID,
      subject: `user:${TARGET_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { role: OrgRole.Member },
    });
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('lowers the owner count, guarded, when the member was an Owner', async () => {
    targetHolds(OrgRole.Owner);

    await handler(removeEvent(), buildContext());

    expect(
      transactItems().find((item) => item.Update?.Key?.sk?.S === 'META')!.Update,
    ).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount - :one ADD ownerSetRev :one',
      ConditionExpression: 'ownerCount > :one',
    });
  });

  it('refuses an Admin removing an Owner', async () => {
    // Removal counts against the same ceiling as demotion, otherwise deleting
    // an Owner would reach what demoting one forbids.
    callerHolds(OrgRole.Admin);
    targetHolds(OrgRole.Owner);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses to remove the last Owner', async () => {
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
  });

  it('lets an Admin remove themselves', async () => {
    // Self-removal is "leave this organization", and it goes through the same
    // rules rather than a second endpoint.
    callerHolds(OrgRole.Admin);
    targetHolds(OrgRole.Admin, USER_ID);

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
  });

  it('refuses a Member trying to leave, because the matrix grants them no removal', async () => {
    // Not an oversight in this handler: `members.manage` is what the route
    // costs, a Member does not hold it, and "leave this organization" for a
    // Member or ReadOnly is a product decision the M1 matrix does not make.
    callerHolds(OrgRole.Member);
    targetHolds(OrgRole.Member, USER_ID);

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
  });

  it('stops the last Owner leaving by the same guard', async () => {
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Owner, USER_ID);
    stubTargetProfile(TARGET_EMAIL, USER_ID);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
  });

  it('does not call an Owner the last one when there is no counter to read', async () => {
    // The decrement conditions on `ownerCount`, so a missing META row cancels
    // the same item for the opposite reason: the guard was never armed. Saying
    // LAST_OWNER there would diagnose an org we cannot diagnose, and it
    // self-heals within a day of the drift checker's next run.
    targetHolds(OrgRole.Owner);
    stubOwnerCount(undefined);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBeUndefined();
    expect(body(result).message).toStrictEqual(expect.stringContaining('contact support'));
    expect(console.error).toHaveBeenCalled();
  });

  it('reports a transient conflict as a failure rather than a verdict', async () => {
    // TransactionConflict cancels an item exactly as a failed condition does.
    // Read as the guard firing, a conflict on the counter would tell an Owner
    // they are the last one and a conflict on the membership row would tell a
    // member they do not exist.
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'TransactionConflict' },
          { Code: 'None' },
        ],
      }),
    );

    const result = await handler(removeEvent(), buildContext());

    // A 500 the client retries, not a 409 that names an invariant.
    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('revokes every invitation the departing member issued', async () => {
    stubTargetInvitations(2);

    await handler(removeEvent(), buildContext());

    const items = transactItems();
    expect(
      items.filter((item) => item.Update?.UpdateExpression === 'SET #status = :status'),
    ).toHaveLength(2);
    // Two status updates, two token deletes, plus the membership pair.
    expect(items.filter((item) => item.Delete)).toHaveLength(4);
    expect(unmarshall(auditItemIn(items)).details).toMatchObject({ revokedInvitations: 2 });
  });

  it('revokes the invitations addressed to the departing member', async () => {
    // The token in such a link still works: their verified address still
    // matches it and the inviter still holds the authority they invited with.
    // Left alone, an Owner invitation issued before a demotion turns
    // demote-then-remove into a re-entry as Owner.
    stubInvitationRows([
      invitationRow({
        inviteId: 'to-them',
        emailNorm: 'departing.person@example.com',
        invitedBy: USER_ID,
        role: OrgRole.Owner,
      }),
      invitationRow({
        inviteId: 'to-somebody-else',
        emailNorm: 'other@example.com',
        invitedBy: USER_ID,
      }),
    ]);

    await handler(removeEvent(), buildContext());

    const items = transactItems();
    const revoked = items.filter(
      (item) => item.Update?.UpdateExpression === 'SET #status = :status',
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0].Update?.Key?.sk?.S).toBe(OrgKeys.inviteSk('to-them'));
    expect(JSON.stringify(items)).not.toContain('to-somebody-else');
    expect(unmarshall(auditItemIn(items)).details).toMatchObject({ revokedInvitations: 1 });
  });

  it('counts an invitation they both issued and received once', async () => {
    stubInvitationRows([
      invitationRow({ inviteId: 'self-invited', emailNorm: 'departing.person@example.com' }),
    ]);

    await handler(removeEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems())).details).toMatchObject({
      revokedInvitations: 1,
    });
  });

  it('matches the departing member’s address regardless of case', async () => {
    // The row stores the address as the inviter typed it and lowercased beside
    // it; the profile stores it as Auth0 has it. Only case may differ.
    stubTargetProfile('DEPARTING.PERSON@EXAMPLE.COM');
    stubInvitationRows([
      invitationRow({
        inviteId: 'to-them',
        emailNorm: 'departing.person@example.com',
        invitedBy: USER_ID,
      }),
    ]);

    await handler(removeEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems())).details).toMatchObject({
      revokedInvitations: 1,
    });
  });

  it('still removes the member when we hold no address for them, and says so', async () => {
    stubTargetProfile(undefined);
    stubInvitationRows([
      invitationRow({ inviteId: 'issued', emailNorm: 'person-0@example.com' }),
      invitationRow({
        inviteId: 'to-them',
        emailNorm: 'departing.person@example.com',
        invitedBy: USER_ID,
      }),
    ]);

    const result = await handler(removeEvent(), buildContext());

    // The removal is the urgent act; the invitation to them stays live until it
    // expires, which is a line an operator can act on rather than a silence.
    expect(result).toMatchObject({ statusCode: 204 });
    expect(unmarshall(auditItemIn(transactItems())).details).toMatchObject({
      revokedInvitations: 1,
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('No address');
  });

  it('returns 404 for somebody who is not a member', async () => {
    targetHolds(undefined);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 404 when somebody else removed them first', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 3));
    // The delete's condition covers the row and its role, so the row is what
    // says which one lost: gone here, which is the outcome the caller wanted.
    targetOnSecondRead(undefined);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when the member was promoted while the removal was in flight', async () => {
    // A promotion touches the member row and META, neither of them an item this
    // transaction conflicts on, so without the role condition the Owner would be
    // deleted with no decrement and the counter would overcount — after which
    // `ownerCount > :one` passes for the genuine last Owner. The condition
    // cancels instead, and the answer is not "already removed".
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 3));
    targetOnSecondRead(OrgRole.Owner);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).message).toContain('role changed');
  });

  it('leaves the member’s keys alone', async () => {
    // M1 removes the membership and nothing else; the console names the keys in
    // its confirmation dialog and FIL-1021 adds the revoke-by-default flow.
    await handler(removeEvent(), buildContext());

    const written = JSON.stringify(transactItems());
    expect(written).not.toContain('ACCESSKEY');
    expect(written).not.toContain('RAGKEY');
  });

  it('returns 400 with no member id in the path', async () => {
    const result = await handler(removeEvent(null), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
