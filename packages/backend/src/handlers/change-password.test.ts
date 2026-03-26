import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInitiatePasswordReset = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  initiatePasswordReset: (...args: unknown[]) => mockInitiatePasswordReset(...args),
}));

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
    Auth0MgmtRuntimeClientId: { value: 'test-mgmt-runtime-client-id' },
    Auth0MgmtRuntimeClientSecret: { value: 'test-mgmt-runtime-client-secret' },
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

import { handler } from './change-password.js';
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

function changePasswordEvent(sub: string = MOCK_SUB) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub },
    method: 'POST',
    rawPath: '/api/me/change-password',
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

describe('POST /api/me/change-password handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockInitiatePasswordReset.mockResolvedValue(undefined);
  });

  it('sends password reset email for database connection users', async () => {
    setupAuthMocks();

    const result = await handler(changePasswordEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'Password reset email sent.' }),
    });
    expect(mockInitiatePasswordReset).toHaveBeenCalledWith(MOCK_EMAIL, 'test-client-id');
  });

  it('returns 400 for social login users', async () => {
    setupAuthMocks(MOCK_SOCIAL_SUB);

    const result = await handler(changePasswordEvent(MOCK_SOCIAL_SUB), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockInitiatePasswordReset).not.toHaveBeenCalled();
  });

  it('returns 502 when Auth0 change_password fails', async () => {
    setupAuthMocks();
    mockInitiatePasswordReset.mockRejectedValue(new Error('Auth0 change_password failed (500)'));

    const result = await handler(changePasswordEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 502 });
  });
});
