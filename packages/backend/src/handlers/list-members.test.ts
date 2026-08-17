import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

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

import { handler } from './list-members.js';
import { OrgKeys } from '../lib/org-membership.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

const MOCK_SUB = 'auth0|member';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'caller-user-id';
const EMAIL = 'caller@example.com';

interface MemberSpec {
  userId: string;
  role?: string;
  joinedAt?: string;
  source?: string;
  invitedBy?: string;
}

function memberRow(spec: MemberSpec) {
  return {
    pk: { S: OrgKeys.orgPk(ORG_ID) },
    sk: { S: OrgKeys.memberSk(spec.userId) },
    role: { S: spec.role ?? OrgRole.Member },
    ...(spec.joinedAt === undefined ? {} : { joinedAt: { S: spec.joinedAt } }),
    ...(spec.source ? { source: { S: spec.source } } : {}),
    ...(spec.invitedBy ? { invitedBy: { S: spec.invitedBy } } : {}),
  };
}

function stubMembers(...specs: MemberSpec[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'MEMBER#' },
      },
    })
    .resolves({ Items: specs.map(memberRow) });
}

function listEvent() {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'GET',
    rawPath: '/api/org/members',
  });
}

function members(result: unknown): MemberSummary[] {
  return JSON.parse((result as { body: string }).body).members;
}

describe('GET /api/org/members handler', () => {
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

    stubMembers({ userId: USER_ID, role: OrgRole.Owner, joinedAt: '2026-01-01T00:00:00.000Z' });
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner });
  });

  it('lists the org’s members with how each of them arrived', async () => {
    stubMembers(
      { userId: USER_ID, role: OrgRole.Owner, joinedAt: '2026-01-01T00:00:00.000Z' },
      {
        userId: 'invited-user',
        role: OrgRole.Member,
        joinedAt: '2026-08-01T00:00:00.000Z',
        source: 'invitation',
        invitedBy: USER_ID,
      },
    );

    const result = await handler(listEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(members(result)).toStrictEqual([
      { userId: USER_ID, role: OrgRole.Owner, joinedAt: '2026-01-01T00:00:00.000Z' },
      {
        userId: 'invited-user',
        role: OrgRole.Member,
        joinedAt: '2026-08-01T00:00:00.000Z',
        source: 'invitation',
        invitedBy: USER_ID,
      },
    ]);
  });

  it('reads the org’s partition consistently', async () => {
    // A member added or removed moments ago must not still be the list the
    // caller acts on next.
    await handler(listEvent(), buildContext());

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      TableName: 'OrgTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ConsistentRead: true,
    });
  });

  it('puts the longest-standing members first and the undated ones last', async () => {
    stubMembers(
      { userId: 'undated' },
      { userId: 'newer', joinedAt: '2026-08-01T00:00:00.000Z' },
      { userId: 'oldest', joinedAt: '2026-01-01T00:00:00.000Z' },
    );

    const result = await handler(listEvent(), buildContext());

    expect(members(result).map((member) => member.userId)).toStrictEqual([
      'oldest',
      'newer',
      'undated',
    ]);
  });

  it('drops a row whose role nothing can authorize', async () => {
    // Rendering role controls for a role the registry does not know would give
    // an operator buttons that always fail.
    stubMembers({ userId: USER_ID, role: OrgRole.Owner }, { userId: 'broken', role: 'billing' });

    const result = await handler(listEvent(), buildContext());

    expect(members(result).map((member) => member.userId)).toStrictEqual([USER_ID]);
    expect(console.error).toHaveBeenCalled();
  });

  it('names a member when their profile row has learned a name and an address', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `USER#${USER_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { email: { S: 'owner@example.com' }, name: { S: 'The Owner' } } });

    const result = await handler(listEvent(), buildContext());

    expect(members(result)[0]).toMatchObject({ email: 'owner@example.com', name: 'The Owner' });
  });

  it('leaves those fields out when the profile row carries neither', async () => {
    // Today's `USER#{userId}/PROFILE` rows hold a sub, an org and a creation
    // date. The roster is honest about that rather than inventing a name.
    const result = await handler(listEvent(), buildContext());

    expect(members(result)[0]).toStrictEqual({
      userId: USER_ID,
      role: OrgRole.Owner,
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('costs one member their display fields when their profile will not read', async () => {
    stubMembers({ userId: USER_ID, role: OrgRole.Owner }, { userId: 'other-user' });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `USER#other-user` }, sk: { S: 'PROFILE' } },
      })
      .rejects(new Error('DynamoDB unavailable'));

    const result = await handler(listEvent(), buildContext());

    // A page that renders everyone but one name beats a page that renders
    // nobody.
    expect(result).toMatchObject({ statusCode: 200 });
    expect(members(result)).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();
  });

  describeRoleEnforcement({
    permission: 'members.read',
    orgId: ORG_ID,
    userId: USER_ID,
    invoke: (membership) => {
      if (membership === NO_MEMBERSHIP) {
        stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID });
      } else {
        stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: membership.role });
      }
      return handler(listEvent(), buildContext());
    },
  });
});
