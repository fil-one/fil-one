import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMfaEnrollments = vi.fn();
const mockEnrollEmailMfa = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
  enrollEmailMfa: (...args: unknown[]) => mockEnrollEmailMfa(...args),
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

import { handler } from './enroll-email-mfa.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function enrollEmailEvent() {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: MOCK_SUB },
    method: 'POST',
    rawPath: '/api/mfa/enroll-email',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function setupAuthMocks() {
  mockJwtVerify
    .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
    .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });

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

describe('POST /api/mfa/enroll-email handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('enrolls email MFA when user has no existing MFA factors', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([]);
    mockEnrollEmailMfa.mockResolvedValue(undefined);

    const result = await handler(enrollEmailEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'Email MFA has been enabled.' }),
    });
    expect(mockEnrollEmailMfa).toHaveBeenCalledWith(MOCK_SUB, MOCK_EMAIL);
  });

  it('returns 400 when user already has MFA factors enrolled', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'otp|1', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = await handler(enrollEmailEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({
        message: 'Email MFA can only be enabled when no other MFA methods are active.',
      }),
    });
    expect(mockEnrollEmailMfa).not.toHaveBeenCalled();
  });
});
