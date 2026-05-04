import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMfaEnrollments = vi.fn();
const mockRegenerateRecoveryCode = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
  regenerateRecoveryCode: (...args: unknown[]) => mockRegenerateRecoveryCode(...args),
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
const mockDecodeJwt = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: (token: unknown) => mockDecodeJwt(token),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './regenerate-recovery-code.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function regenerateEvent() {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: MOCK_SUB },
    method: 'POST',
    rawPath: '/api/mfa/recovery-code/regenerate',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function setupAuthMocks(idTokenClaims: Record<string, unknown> = { amr: ['mfa'] }) {
  mockJwtVerify
    .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
    .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });

  mockDecodeJwt.mockReturnValue(idTokenClaims);

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

describe('POST /api/mfa/recovery-code/regenerate handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns the new recovery code when MFA is enrolled and the ID token has amr: ["mfa"]', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'auth-1', type: 'authenticator', status: 'confirmed' },
    ]);
    mockRegenerateRecoveryCode.mockResolvedValue('K6LGLV3RSH3VERMKET8L7QKU');

    const result = await handler(regenerateEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        recoveryCode: 'K6LGLV3RSH3VERMKET8L7QKU',
        message: 'New recovery code generated. The previous code has been invalidated.',
      }),
    });
    expect(mockRegenerateRecoveryCode).toHaveBeenCalledWith(MOCK_SUB);
  });

  it('returns 400 when MFA is not currently enabled', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = await handler(regenerateEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ message: 'MFA is not currently enabled.' }),
    });
    expect(mockRegenerateRecoveryCode).not.toHaveBeenCalled();
  });

  it('returns 401 step_up_required when the ID token has no amr: ["mfa"]', async () => {
    setupAuthMocks({ amr: ['pwd'] });
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'auth-1', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = await handler(regenerateEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
    expect(mockRegenerateRecoveryCode).not.toHaveBeenCalled();
  });

  it('propagates Management API errors via the error handler', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'auth-1', type: 'authenticator', status: 'confirmed' },
    ]);
    mockRegenerateRecoveryCode.mockRejectedValue(new Error('Auth0 boom'));

    const result = await handler(regenerateEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 500,
      body: JSON.stringify({
        message: 'An unexpected server error occurred. Please try again later.',
      }),
    });
  });
});
