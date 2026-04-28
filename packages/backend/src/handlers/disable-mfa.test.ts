import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMfaEnrollments = vi.fn();
const mockDeleteAllAuthenticators = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
  deleteAllAuthenticators: (...args: unknown[]) => mockDeleteAllAuthenticators(...args),
}));

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
    Auth0MgmtClientId: { value: 'test-mgmt-client-id' },
    Auth0MgmtClientSecret: { value: 'test-mgmt-client-secret' },
    AuroraBackofficeToken: { value: 'test-aurora-token' },
  },
}));

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

import { handler } from './disable-mfa.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_SOCIAL_SUB = 'google-oauth2|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function disableMfaEvent(sub: string = MOCK_SUB) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub },
    method: 'POST',
    rawPath: '/api/mfa/disable',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function setupAuthMocks(sub: string = MOCK_SUB) {
  mockJwtVerify
    .mockResolvedValueOnce({ payload: { sub } })
    .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });

  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
    })
    .resolves({
      Item: {
        userId: { S: MOCK_USER_ID },
        orgId: { S: MOCK_ORG_ID },
      },
    });

  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        orgConfirmed: { BOOL: true },
        setupStatus: { S: 'AURORA_S3_ACCESS_KEY_CREATED' },
      },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/mfa/disable handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('disables MFA and deletes authenticators for database connection users', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
    mockDeleteAllAuthenticators.mockResolvedValue(undefined);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA has been disabled.' }),
    });
    expect(mockDeleteAllAuthenticators).toHaveBeenCalledWith(MOCK_SUB);
  });

  it('disables MFA for social login users', async () => {
    setupAuthMocks(MOCK_SOCIAL_SUB);
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
    mockDeleteAllAuthenticators.mockResolvedValue(undefined);

    const result = await handler(disableMfaEvent(MOCK_SOCIAL_SUB), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA has been disabled.' }),
    });
    expect(mockDeleteAllAuthenticators).toHaveBeenCalledWith(MOCK_SOCIAL_SUB);
  });

  it('returns 400 when MFA is not currently enabled', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ message: 'MFA is not currently enabled.' }),
    });
    expect(mockDeleteAllAuthenticators).not.toHaveBeenCalled();
  });
});
