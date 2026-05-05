import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMfaEnrollments = vi.fn();
const mockDeleteGuardianEnrollment = vi.fn();
const mockDeleteAuthenticationMethod = vi.fn();
const mockUpdateAuth0User = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
  deleteGuardianEnrollment: (...args: unknown[]) => mockDeleteGuardianEnrollment(...args),
  deleteAuthenticationMethod: (...args: unknown[]) => mockDeleteAuthenticationMethod(...args),
  updateAuth0User: (...args: unknown[]) => mockUpdateAuth0User(...args),
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

import { handler } from './delete-mfa-enrollment.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';
const MOCK_ENROLLMENT_ID = 'webauthn-roaming|dev_abc';

function deleteEnrollmentEvent(enrollmentId: string = MOCK_ENROLLMENT_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: MOCK_SUB },
    method: 'DELETE',
    rawPath: `/api/mfa/enrollments/${enrollmentId}`,
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  (event as unknown as Record<string, unknown>).pathParameters = { enrollmentId };
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

describe('DELETE /api/mfa/enrollments/{enrollmentId} handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('deletes WebAuthn enrollment via authentication-methods and does not clear flag when other enrollments remain', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: MOCK_ENROLLMENT_ID,
        type: 'webauthn-roaming',
        status: 'confirmed',
        source: 'auth-methods',
      },
      {
        id: 'totp|dev_xyz',
        type: 'authenticator',
        status: 'confirmed',
        source: 'auth-methods',
      },
    ]);
    mockDeleteAuthenticationMethod.mockResolvedValue(undefined);

    const result = await handler(deleteEnrollmentEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA enrollment removed.' }),
    });
    expect(mockDeleteAuthenticationMethod).toHaveBeenCalledWith(MOCK_SUB, MOCK_ENROLLMENT_ID);
    expect(mockDeleteGuardianEnrollment).not.toHaveBeenCalled();
    expect(mockUpdateAuth0User).not.toHaveBeenCalled();
  });

  it('deletes a TOTP enrollment via authentication-methods (modern source)', async () => {
    const totpEnrollmentId = 'totp|dev_xyz';
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: totpEnrollmentId,
        type: 'authenticator',
        status: 'confirmed',
        source: 'auth-methods',
      },
    ]);
    mockDeleteAuthenticationMethod.mockResolvedValue(undefined);
    mockUpdateAuth0User.mockResolvedValue(undefined);

    const result = await handler(deleteEnrollmentEvent(totpEnrollmentId), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA enrollment removed.' }),
    });
    expect(mockDeleteAuthenticationMethod).toHaveBeenCalledWith(MOCK_SUB, totpEnrollmentId);
    expect(mockDeleteGuardianEnrollment).not.toHaveBeenCalled();
    expect(mockUpdateAuth0User).toHaveBeenCalledWith(MOCK_SUB, {
      app_metadata: { mfa_enrolling: false },
    });
  });

  it('deletes a legacy OTP enrollment via Guardian when source is "guardian"', async () => {
    const otpEnrollmentId = 'otp|dev_xyz';
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      {
        id: otpEnrollmentId,
        type: 'authenticator',
        status: 'confirmed',
        source: 'guardian',
      },
    ]);
    mockDeleteGuardianEnrollment.mockResolvedValue(undefined);
    mockUpdateAuth0User.mockResolvedValue(undefined);

    const result = await handler(deleteEnrollmentEvent(otpEnrollmentId), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA enrollment removed.' }),
    });
    expect(mockDeleteGuardianEnrollment).toHaveBeenCalledWith(otpEnrollmentId);
    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
    expect(mockUpdateAuth0User).toHaveBeenCalledWith(MOCK_SUB, {
      app_metadata: { mfa_enrolling: false },
    });
  });

  it('returns 404 when enrollment does not belong to user', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'authenticator|dev_other', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = await handler(deleteEnrollmentEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ message: 'Enrollment not found.' }),
    });
    expect(mockDeleteGuardianEnrollment).not.toHaveBeenCalled();
  });

  it('returns 404 when user has no enrollments', async () => {
    setupAuthMocks();
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = await handler(deleteEnrollmentEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ message: 'Enrollment not found.' }),
    });
    expect(mockDeleteGuardianEnrollment).not.toHaveBeenCalled();
  });
});
