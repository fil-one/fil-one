import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
    AuroraBackofficeToken: { value: 'test-aurora-token' },
  },
}));

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
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

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
  });

  it('returns the org profile', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          auroraSetupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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
      }),
    });
  });

  it('returns 200 with emailVerified false for unverified users (verified-email gate opt-out)', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: false },
    });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          auroraSetupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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
      }),
    });
  });

  it('does not call getMfaEnrollments when include=mfa is absent', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          auroraSetupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          auroraSetupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          setupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          setupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

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
      }),
    });
  });
});
