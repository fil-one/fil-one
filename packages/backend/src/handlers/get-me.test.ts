import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
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
import {
  buildEvent,
  buildContext,
  stubAbsentMembershipRead,
  stubMembershipList,
  stubMembershipRead,
  STUB_JOINED_AT,
} from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';

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

/** The role fields every response carries, in the order the handler writes them. */
function ownerTail(orgName: string) {
  return {
    userId: MOCK_USER_ID,
    role: OrgRole.Owner,
    permissions: [...ROLE_PERMISSIONS[OrgRole.Owner]],
    memberships: [
      { orgId: MOCK_ORG_ID, orgName, slug: '', role: OrgRole.Owner, joinedAt: STUB_JOINED_AT },
    ],
    orgsBeta: false,
  };
}

/**
 * Either row that grants the organizations beta, absent or present.
 *
 * Both are stubbed on every test so the whole-body assertions read a decided
 * `orgsBeta` rather than whatever an unstubbed `GetItemCommand` returns.
 */
function orgsBetaRow(pk: string, exists: boolean) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } },
      ConsistentRead: true,
    })
    .resolves(exists ? { Item: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } } } : { Item: undefined });
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

    // Default: nobody is in the organizations beta. Matched on the sort key
    // alone, because both grant rows are read on every call and a test that
    // moves the caller's email or active org would otherwise leave one of them
    // unstubbed — which reads as a thrown handler, not as a denied flag.
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable', Key: { sk: { S: 'ORGS_BETA' } } })
      .resolves({ Item: undefined });

    // Default membership: sole Owner of the one org, as every account is today.
    stubMembershipRead(ddbMock, {
      orgId: MOCK_ORG_ID,
      userId: MOCK_USER_ID,
      role: OrgRole.Owner,
    });
    stubMembershipList(ddbMock, {
      userId: MOCK_USER_ID,
      orgs: [{ orgId: MOCK_ORG_ID, role: OrgRole.Owner }],
    });
  });

  it('returns the org profile', async () => {
    profileResolves();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        slug: '',
        nameConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        mfaEnrollments: [],
        connectionType: 'auth0',
        ragAccess: false,
        ...ownerTail('Example Corp'),
      }),
    });
  });

  it('reads the active org profile consistently, so a just-created org is never named empty', async () => {
    profileResolves();

    await handler(authenticatedEvent(), buildContext());

    // Other code paths (e.g. the deletion fence) read this same row without
    // consistency, on purpose — so this checks that at least one read of it
    // was consistent, the one `/me` itself makes to name the org, rather than
    // asserting every read of the key was.
    const profileReads = ddbMock
      .commandCalls(GetItemCommand)
      .filter(
        (call) =>
          call.args[0].input.TableName === 'UserInfoTable' &&
          call.args[0].input.Key?.pk?.S === `ORG#${MOCK_ORG_ID}` &&
          call.args[0].input.Key?.sk?.S === 'PROFILE',
      );
    expect(profileReads.some((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
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
        slug: '',
        nameConfirmed: true,
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
        slug: '',
        nameConfirmed: true,
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
        slug: '',
        nameConfirmed: true,
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
        slug: '',
        nameConfirmed: true,
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
        slug: '',
        nameConfirmed: true,
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

  describe('the active org it echoes', () => {
    const SECOND_ORG = '22222222-2222-2222-2222-222222222222';

    function eventNaming(orgId: string) {
      const event = authenticatedEvent();
      event.headers['x-org-id'] = orgId;
      return event;
    }

    function resolvedOrgId(result: unknown): string {
      return (JSON.parse((result as { body: string }).body) as { orgId: string }).orgId;
    }

    it('echoes the org the header named', async () => {
      profileResolves();
      profileResolves(SECOND_ORG, 'Second Corp');
      stubMembershipRead(ddbMock, {
        orgId: SECOND_ORG,
        userId: MOCK_USER_ID,
        role: OrgRole.Admin,
      });

      const result = await handler(eventNaming(SECOND_ORG), buildContext());

      // The console compares this against its own stash, so it has to name the
      // org the request was actually served in.
      expect(resolvedOrgId(result)).toBe(SECOND_ORG);
    });

    it('echoes the caller’s own org when the named one has no membership row', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      profileResolves();
      profileResolves(SECOND_ORG, 'Second Corp');
      stubAbsentMembershipRead(ddbMock, { orgId: SECOND_ORG, userId: MOCK_USER_ID });

      const result = await handler(eventNaming(SECOND_ORG), buildContext());

      // A stale stash — removed from the org, or the org is gone. This route
      // answers instead of refusing, because the mismatch it reports is what
      // makes the console clear the stash. Every other route 403s and sends the
      // console here.
      expect(resolvedOrgId(result)).toBe(MOCK_ORG_ID);
    });

    it('echoes the caller’s own org when the header is not an organization id', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      profileResolves();

      const result = await handler(eventNaming('not-a-uuid'), buildContext());

      // The 400 every other route answers would leave the console holding a
      // stash it cannot read and no endpoint willing to tell it so. Answering
      // under the caller's own org echoes an org id the stash disagrees with,
      // which is what clears it.
      expect(result).toMatchObject({ statusCode: 200 });
      expect(resolvedOrgId(result)).toBe(MOCK_ORG_ID);
    });
  });

  describe('role and memberships', () => {
    function parseBody(result: unknown) {
      return JSON.parse((result as { body: string }).body) as {
        userId: string;
        role: OrgRole;
        permissions: string[];
        memberships: Array<{
          orgId: string;
          orgName: string;
          slug: string;
          role: OrgRole;
          joinedAt?: string;
        }>;
      };
    }

    it('ships the role and its permissions so the console can gate rendering', async () => {
      profileResolves();
      stubMembershipRead(ddbMock, {
        orgId: MOCK_ORG_ID,
        userId: MOCK_USER_ID,
        role: OrgRole.ReadOnly,
      });
      stubMembershipList(ddbMock, {
        userId: MOCK_USER_ID,
        orgs: [{ orgId: MOCK_ORG_ID, role: OrgRole.ReadOnly }],
      });

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      expect(body.userId).toBe(MOCK_USER_ID);
      expect(body.role).toBe(OrgRole.ReadOnly);
      expect(body.permissions).toStrictEqual([...ROLE_PERMISSIONS[OrgRole.ReadOnly]]);
      expect(body.memberships).toStrictEqual([
        {
          orgId: MOCK_ORG_ID,
          orgName: 'Example Corp',
          slug: '',
          role: OrgRole.ReadOnly,
          joinedAt: STUB_JOINED_AT,
        },
      ]);
    });

    it('names every org the user belongs to', async () => {
      const secondOrgId = 'org-2';
      profileResolves();
      profileResolves(secondOrgId, 'Second Corp');
      stubMembershipList(ddbMock, {
        userId: MOCK_USER_ID,
        orgs: [
          { orgId: MOCK_ORG_ID, role: OrgRole.Owner },
          { orgId: secondOrgId, role: OrgRole.Member },
        ],
      });

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      expect(body.memberships).toStrictEqual([
        {
          orgId: MOCK_ORG_ID,
          orgName: 'Example Corp',
          slug: '',
          role: OrgRole.Owner,
          joinedAt: STUB_JOINED_AT,
        },
        {
          orgId: secondOrgId,
          orgName: 'Second Corp',
          slug: '',
          role: OrgRole.Member,
          joinedAt: STUB_JOINED_AT,
        },
      ]);
    });

    it('reports no role at all when no membership row exists', async () => {
      profileResolves();
      stubAbsentMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID });
      stubMembershipList(ddbMock, { userId: MOCK_USER_ID, orgs: [] });

      const body = parseBody(await handler(authenticatedEvent(), buildContext()));

      // /api/me is a `self` route and answers without a role gate, which is
      // what lets the console tell a caller they are not a member rather than
      // showing them an empty console. Every gated route refuses them.
      expect(body.role).toBeUndefined();
      expect(body.permissions).toStrictEqual([]);
      expect(body.memberships).toStrictEqual([]);
    });

    it('never 500s when another org profile cannot be read', async () => {
      const secondOrgId = 'org-2';
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      profileResolves();
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: `ORG#${secondOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .rejects(new Error('DynamoDB unavailable'));
      stubMembershipList(ddbMock, {
        userId: MOCK_USER_ID,
        orgs: [
          { orgId: MOCK_ORG_ID, role: OrgRole.Owner },
          { orgId: secondOrgId, role: OrgRole.Member },
        ],
      });

      const result = await handler(authenticatedEvent(), buildContext());

      expect((result as { statusCode: number }).statusCode).toBe(200);
      expect(parseBody(result).memberships).toStrictEqual([
        {
          orgId: MOCK_ORG_ID,
          orgName: 'Example Corp',
          slug: '',
          role: OrgRole.Owner,
          joinedAt: STUB_JOINED_AT,
        },
        {
          orgId: secondOrgId,
          orgName: '',
          slug: '',
          role: OrgRole.Member,
          joinedAt: STUB_JOINED_AT,
        },
      ]);
      consoleError.mockRestore();
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

  describe('orgsBeta', () => {
    function parseBody(result: unknown): { orgsBeta: boolean } {
      return JSON.parse((result as { body: string }).body);
    }

    it('is false when neither the caller nor the org holds the flag', async () => {
      profileResolves();

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).orgsBeta).toBe(false);
    });

    it('is true from the caller’s own allowlist row', async () => {
      profileResolves();
      orgsBetaRow(`ALLOWLIST#${MOCK_EMAIL}`, true);

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).orgsBeta).toBe(true);
    });

    it('is true from the active org’s row, for a caller who holds nothing', async () => {
      profileResolves();
      orgsBetaRow(`ORG#${MOCK_ORG_ID}`, true);

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).orgsBeta).toBe(true);
    });

    it('ignores an allowlist row when the email is unverified', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: false },
      });
      profileResolves();
      orgsBetaRow(`ALLOWLIST#${MOCK_EMAIL}`, true);

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).orgsBeta).toBe(false);
    });

    it('grants the org row even when the caller’s email is unverified', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: false },
      });
      profileResolves();
      orgsBetaRow(`ORG#${MOCK_ORG_ID}`, true);

      const result = await handler(authenticatedEvent(), buildContext());

      expect(parseBody(result).orgsBeta).toBe(true);
    });
  });
});
