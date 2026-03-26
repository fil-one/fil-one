import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSendVerificationEmail = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
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

import { handler } from './resend-verification.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function resendEvent(emailVerified: boolean) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, emailVerified },
    method: 'POST',
    rawPath: '/api/me/resend-verification',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/me/resend-verification handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockSendVerificationEmail.mockResolvedValue(undefined);

    mockJwtVerify
      .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
      .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
        },
      });

    // Bypass route — org confirmation not required, but mock it confirmed anyway
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          orgConfirmed: { BOOL: true },
        },
      });
  });

  it('sends verification email for unverified users', async () => {
    const result = await handler(resendEvent(false), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'Verification email sent.' }),
    });
    expect(mockSendVerificationEmail).toHaveBeenCalledWith(MOCK_SUB);
  });

  it('returns 400 when email is already verified', async () => {
    mockJwtVerify.mockReset();
    mockJwtVerify
      .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
      .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });

    const result = await handler(resendEvent(true), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });
});
