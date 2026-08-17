import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
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

import { handler } from './list-invitations.js';
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

interface RowSpec {
  inviteId: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
  role?: OrgRole;
}

function row(spec: RowSpec) {
  return {
    pk: { S: OrgKeys.orgPk(ORG_ID) },
    sk: { S: OrgKeys.inviteSk(spec.inviteId) },
    email: { S: `${spec.inviteId}@example.com` },
    emailNorm: { S: `${spec.inviteId}@example.com` },
    role: { S: spec.role ?? OrgRole.Member },
    invitedBy: { S: USER_ID },
    status: { S: spec.status ?? 'pending' },
    createdAt: { S: spec.createdAt ?? '2026-08-14T00:00:00.000Z' },
    expiresAt: { S: spec.expiresAt ?? inviteExpiresAt(new Date().toISOString()) },
    tokenHash: { S: 'c'.repeat(64) },
  };
}

function stubRows(...specs: RowSpec[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
    })
    .resolves({ Items: specs.map(row) });
}

function listEvent() {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'GET',
    rawPath: '/api/org/invitations',
  });
}

function invitations(result: unknown) {
  return JSON.parse((result as { body: string }).body).invitations as {
    inviteId: string;
    expired: boolean;
  }[];
}

describe('GET /api/org/invitations handler', () => {
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
    stubRows();
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner });
  });

  it('lists the invitations still waiting on somebody', async () => {
    stubRows(
      { inviteId: 'pending-one' },
      { inviteId: 'accepted-one', status: 'accepted' },
      { inviteId: 'revoked-one', status: 'revoked' },
    );

    const result = await handler(listEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    // Accepted and revoked rows are history, and history is the audit log's job.
    expect(invitations(result).map((invitation) => invitation.inviteId)).toStrictEqual([
      'pending-one',
    ]);
  });

  it('keeps an expired invitation on the list, flagged', async () => {
    // Expiry is not a status: "nobody accepted and the link has run out" is
    // exactly what the person looking at this page is trying to find out.
    stubRows({ inviteId: 'stale', expiresAt: '2026-07-01T00:00:00.000Z' });

    const result = await handler(listEvent(), buildContext());

    expect(invitations(result)).toStrictEqual([expect.objectContaining({ expired: true })]);
  });

  it('returns the newest first', async () => {
    stubRows(
      { inviteId: 'older', createdAt: '2026-08-01T00:00:00.000Z' },
      { inviteId: 'newer', createdAt: '2026-08-14T00:00:00.000Z' },
    );

    const result = await handler(listEvent(), buildContext());

    expect(invitations(result).map((invitation) => invitation.inviteId)).toStrictEqual([
      'newer',
      'older',
    ]);
  });

  it('carries no token material in the response', async () => {
    stubRows({ inviteId: 'pending-one' });

    const result = await handler(listEvent(), buildContext());

    const rendered = (result as { body: string }).body;
    expect(rendered).not.toContain('tokenHash');
    expect(rendered).not.toContain('c'.repeat(64));
  });

  it('answers an org with nothing outstanding', async () => {
    const result = await handler(listEvent(), buildContext());

    expect(invitations(result)).toStrictEqual([]);
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
      return handler(listEvent(), buildContext());
    },
  });
});
