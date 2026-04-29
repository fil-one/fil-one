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

const mockTriggerTenantSetup = vi.fn();
vi.mock('../lib/trigger-tenant-setup.js', () => ({
  triggerTenantSetup: (...args: unknown[]) => mockTriggerTenantSetup(...args),
}));

const mockGetMfaEnrollments = vi.fn();
const mockDeleteAuthenticationMethod = vi.fn();
vi.mock('../lib/auth0-management.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
    deleteAuthenticationMethod: (...args: unknown[]) => mockDeleteAuthenticationMethod(...args),
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
    mockTriggerTenantSetup.mockResolvedValue({});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

    mockGetMfaEnrollments.mockResolvedValue([]);

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

  it('returns orgSetupComplete: true when setupStatus is AURORA_S3_ACCESS_KEY_CREATED', async () => {
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

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: true,
        mfaEnrollments: [],
        connectionType: 'auth0',
      }),
    });
  });

  it('returns orgSetupComplete: false when setupStatus is FILONE_ORG_CREATED', async () => {
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
          setupStatus: { S: 'FILONE_ORG_CREATED' },
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: false,
        mfaEnrollments: [],
        connectionType: 'auth0',
      }),
    });
  });

  it('returns orgSetupComplete: false when setupStatus is missing', async () => {
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
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: false,
        mfaEnrollments: [],
        connectionType: 'auth0',
      }),
    });
  });

  it('triggers tenant setup when org is confirmed but setup is incomplete', async () => {
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
          setupStatus: { S: 'FILONE_ORG_CREATED' },
        },
      });

    await handler(authenticatedEvent(), buildContext());

    expect(mockTriggerTenantSetup).toHaveBeenCalledWith({
      orgId: MOCK_ORG_ID,
      orgName: 'Example Corp',
    });
  });

  it('does not trigger tenant setup when setup is already complete', async () => {
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

    await handler(authenticatedEvent(), buildContext());

    expect(mockTriggerTenantSetup).not.toHaveBeenCalled();
  });

  it('returns success even when triggerTenantSetup fails', async () => {
    mockTriggerTenantSetup.mockRejectedValue(new Error('SQS timeout'));

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
          setupStatus: { S: 'FILONE_ORG_CREATED' },
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: false,
        mfaEnrollments: [],
        connectionType: 'auth0',
      }),
    });
  });

  it('does not trigger tenant setup when org is not confirmed', async () => {
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
          orgConfirmed: { BOOL: false },
          setupStatus: { S: 'FILONE_ORG_CREATED' },
        },
      });

    await handler(authenticatedEvent(), buildContext());

    expect(mockTriggerTenantSetup).not.toHaveBeenCalled();
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
          setupStatus: { S: FINAL_SETUP_STATUS },
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
          setupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

    const result = await handler(authenticatedEvent({ include: 'mfa' }), buildContext());

    expect(mockGetMfaEnrollments).toHaveBeenCalledWith(MOCK_SUB, { includeEmail: true });
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: true,
        mfaEnrollments: [
          {
            id: 'webauthn-roaming|dev_abc',
            type: 'webauthn-roaming',
            name: 'My key',
            createdAt: '2026-03-24T00:20:17.000Z',
          },
        ],
        connectionType: 'auth0',
      }),
    });
    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
  });

  it('deletes orphaned email auth-methods when a strong factor is enrolled', async () => {
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: 'authenticator|dev_otp',
        type: 'authenticator',
        status: 'confirmed',
        name: 'My OTP',
        enrolled_at: '2026-04-10T00:00:00.000Z',
      },
      {
        id: 'email|am-1',
        type: 'email',
        status: 'confirmed',
        name: 'Email',
        enrolled_at: '2026-04-01T00:00:00.000Z',
      },
    ]);
    mockDeleteAuthenticationMethod.mockResolvedValue(undefined);

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

    expect(mockDeleteAuthenticationMethod).toHaveBeenCalledWith(MOCK_SUB, 'email|am-1');
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        emailVerified: true,
        email: MOCK_EMAIL,
        orgSetupComplete: true,
        mfaEnrollments: [
          {
            id: 'authenticator|dev_otp',
            type: 'authenticator',
            name: 'My OTP',
            createdAt: '2026-04-10T00:00:00.000Z',
          },
        ],
        connectionType: 'auth0',
      }),
    });
  });

  it('keeps email enrollment when it is the only factor', async () => {
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: 'email|am-1',
        type: 'email',
        status: 'confirmed',
        name: 'Email',
        enrolled_at: '2026-04-01T00:00:00.000Z',
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

    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 200,
      body: expect.stringContaining('"type":"email"'),
    });
  });
});
