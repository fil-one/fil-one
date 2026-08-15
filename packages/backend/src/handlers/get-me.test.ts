import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';
import { sstResourceMock } from '../test/sst-resource-mock.js';

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

const mockGetMfaEnrollments = vi.fn();
const mockGetPasskeyAuthenticators = vi.fn();
vi.mock('../lib/auth0-management.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
    getPasskeyAuthenticators: (...args: unknown[]) => mockGetPasskeyAuthenticators(...args),
  };
});

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './get-me.js';
import { buildEvent, buildContext, stubMembershipRead } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';

const MOCK_JOINED_AT = '2026-01-01T00:00:00.000Z';

function authenticatedEvent(queryStringParameters?: Record<string, string>) {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
    queryStringParameters,
  });
}

/** The `ORG#{orgId}/PROFILE` row `/me` names the org from. */
function profileResolves(orgId: string = MOCK_ORG_ID, name = 'Example Corp') {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
        name: { S: name },
        auroraSetupStatus: { S: FINAL_SETUP_STATUS },
      },
    });
}

/** Stub the inverse-item Query behind `MeResponse.memberships`. */
function membershipsResolve(rows: Array<{ orgId: string; role: OrgRole }>) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${MOCK_USER_ID}` },
        ':skPrefix': { S: 'MEMBERSHIP#' },
      },
    })
    .resolves({
      Items: rows.map((row) => ({
        pk: { S: `USER#${MOCK_USER_ID}` },
        sk: { S: `MEMBERSHIP#${row.orgId}` },
        role: { S: row.role },
        joinedAt: { S: MOCK_JOINED_AT },
      })),
    });
}

/** The role fields every response carries, in the order the handler writes them. */
function ownerTail(orgName: string) {
  return {
    userId: MOCK_USER_ID,
    role: OrgRole.Owner,
    permissions: [...ROLE_PERMISSIONS[OrgRole.Owner]],
    memberships: [{ orgId: MOCK_ORG_ID, orgName, role: OrgRole.Owner }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/me handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

    mockGetMfaEnrollments.mockResolvedValue([]);
    mockGetPasskeyAuthenticators.mockResolvedValue([]);

    // Auth middleware: resolve existing user
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
          email: { S: MOCK_EMAIL },
        },
      });

    // Default: the test user's email is not on the RAG allowlist.
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ALLOWLIST#${MOCK_EMAIL}` }, sk: { S: 'RAG' } },
        ConsistentRead: true,
      })
      .resolves({ Item: undefined });

    // Default membership: sole Owner of the one org, as every account is today.
    stubMembershipRead(ddbMock, {
      orgId: MOCK_ORG_ID,
      userId: MOCK_USER_ID,
      role: OrgRole.Owner,
    });
    membershipsResolve([{ orgId: MOCK_ORG_ID, role: OrgRole.Owner }]);
  });

  it('returns the org profile', async () => {
    profileResolves();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  it('returns 200 with emailVerified false for unverified users (verified-email gate opt-out)', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: false },
    });
    profileResolves();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        emailVerified: false,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  it('degrades gracefully when org profile row is missing (eventual consistency)', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({});

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: '',
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail(''),
      }),
    });
  });

  it('does not call getMfaEnrollments when include=mfa is absent', async () => {
    profileResolves();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 200,
      body: expect.stringContaining('"mfaEnrollments":[]'),
    });
  });

  it('returns enrollments when include=mfa is set', async () => {
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: 'webauthn-roaming|dev_abc',
        type: 'webauthn-roaming',
        status: 'confirmed',
        name: 'My key',
        enrolled_at: '2026-03-24T00:20:17.000Z',
      },
    ]);

    profileResolves();

    const result = await handler(authenticatedEvent({ include: 'mfa' }), buildContext());

    expect(mockGetMfaEnrollments).toHaveBeenCalledWith(MOCK_SUB);
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [
          {
            id: 'webauthn-roaming|dev_abc',
            type: 'webauthn-roaming',
            name: 'My key',
            createdAt: '2026-03-24T00:20:17.000Z',
          },
        ],
        passkeys: [],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  it('returns passkey enrollments when include=mfa is set and the user has passkeys', async () => {
    mockGetPasskeyAuthenticators.mockResolvedValue([
      {
        id: 'passkey|dev_pk1',
        name: 'iPhone',
        created_at: '2026-04-12T13:11:08.000Z',
      },
    ]);

    profileResolves();

    const result = await handler(authenticatedEvent({ include: 'mfa' }), buildContext());

    expect(mockGetPasskeyAuthenticators).toHaveBeenCalledWith(MOCK_SUB);
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        passkeys: [
          {
            id: 'passkey|dev_pk1',
            name: 'iPhone',
            createdAt: '2026-04-12T13:11:08.000Z',
          },
        ],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  it('skips passkey fetch for social-login users (passkeys are database-connection only)', async () => {
    const socialSub = 'google-oauth2|xyz789';
    mockJwtVerify.mockResolvedValue({
      payload: { sub: socialSub, email: MOCK_EMAIL, email_verified: true },
    });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${socialSub}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${socialSub}` },
          sk: { S: 'IDENTITY' },
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
          email: { S: MOCK_EMAIL },
        },
      });
    profileResolves();

    const result = await handler(authenticatedEvent({ include: 'mfa' }), buildContext());

    expect(mockGetMfaEnrollments).toHaveBeenCalledWith(socialSub);
    expect(mockGetPasskeyAuthenticators).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        passkeys: [],
        connectionType: 'google-oauth2',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  describe('role and memberships', () => {
    function profileResolves(orgId: string, name: string) {
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({ Item: { name: { S: name }, auroraSetupStatus: { S: FINAL_SETUP_STATUS } } });
    }

    function parseBody(result: unknown) {
      return JSON.parse((result as { body: string }).body) as {
        userId: string;
        role: OrgRole;
        permissions: string[];
        memberships: Array<{ orgId: string; orgName: string; role: OrgRole }>;
      };
    }

    it('ships the role and its permissions so the console can gate rendering', async () => {
      profileResolves(MOCK_ORG_ID, 'Example Corp');
      stubMembershipRead(ddbMock, {
        orgId: MOCK_ORG_ID,
        userId: MOCK_USER_ID,
        role: OrgRole.ReadOnly,
      });
      membershipsResolve([{ orgId: MOCK_ORG_ID, role: OrgRole.ReadOnly }]);

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      expect(body.userId).toBe(MOCK_USER_ID);
      expect(body.role).toBe(OrgRole.ReadOnly);
      expect(body.permissions).toStrictEqual([...ROLE_PERMISSIONS[OrgRole.ReadOnly]]);
      expect(body.memberships).toStrictEqual([
        { orgId: MOCK_ORG_ID, orgName: 'Example Corp', role: OrgRole.ReadOnly },
      ]);
    });

    it('names every org the user belongs to', async () => {
      const secondOrgId = 'org-2';
      profileResolves(MOCK_ORG_ID, 'Example Corp');
      profileResolves(secondOrgId, 'Second Corp');
      membershipsResolve([
        { orgId: MOCK_ORG_ID, role: OrgRole.Owner },
        { orgId: secondOrgId, role: OrgRole.Member },
      ]);

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      expect(body.memberships).toStrictEqual([
        { orgId: MOCK_ORG_ID, orgName: 'Example Corp', role: OrgRole.Owner },
        { orgId: secondOrgId, orgName: 'Second Corp', role: OrgRole.Member },
      ]);
    });

    it('reports Owner when no membership row exists yet (pre-conversion accounts)', async () => {
      profileResolves(MOCK_ORG_ID, 'Example Corp');
      stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID });
      membershipsResolve([]);

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      expect(body.role).toBe(OrgRole.Owner);
      expect(body.permissions).toStrictEqual([...ROLE_PERMISSIONS[OrgRole.Owner]]);
      expect(body.memberships).toStrictEqual([]);
    });
  });

  describe('ragAccess', () => {
    function parseBody(result: unknown): { ragAccess: boolean } {
      return JSON.parse((result as { body: string }).body);
    }

    it('is true for @fil.org emails (no allowlist lookup needed)', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: 'alice@fil.org', email_verified: true },
      });
      profileResolves();

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).ragAccess).toBe(true);
    });

    it('is true for allowlisted emails', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: 'bob@example.com', email_verified: true },
      });
      profileResolves();
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'RAG' } },
          ConsistentRead: true,
        })
        .resolves({ Item: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'RAG' } } });

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).ragAccess).toBe(true);
    });

    it('is false for neither @fil.org nor allowlisted', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: 'eve@example.com', email_verified: true },
      });
      profileResolves();
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: 'ALLOWLIST#eve@example.com' }, sk: { S: 'RAG' } },
          ConsistentRead: true,
        })
        .resolves({ Item: undefined });

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).ragAccess).toBe(false);
    });

    it('is false when the email is unverified, without an allowlist lookup', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: 'bob@example.com', email_verified: false },
      });
      profileResolves();
      // Allowlist row exists, but an unverified email must never be granted access.
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'RAG' } },
          ConsistentRead: true,
        })
        .resolves({ Item: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'RAG' } } });

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).ragAccess).toBe(false);
    });
  });
});
