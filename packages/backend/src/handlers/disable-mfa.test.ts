import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetMfaEnrollments, mockDeleteAllAuthenticators, mockJwtVerify } = vi.hoisted(() => ({
  mockGetMfaEnrollments: vi.fn(),
  mockDeleteAllAuthenticators: vi.fn(),
  mockJwtVerify: vi.fn(),
}));
vi.mock('../lib/auth0-management.js', async () =>
  (await import('../test/auth-mocks.js')).auth0ManagementMockModule(mockGetMfaEnrollments, {
    getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
    deleteAllAuthenticators: (...args: unknown[]) => mockDeleteAllAuthenticators(...args),
  }),
);

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

vi.mock('../lib/auth-secrets.js', async () =>
  (await import('../test/auth-mocks.js')).authSecretsMockModule(),
);

vi.mock('jose', async () => (await import('../test/auth-mocks.js')).joseMockModule(mockJwtVerify));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './disable-mfa.js';
import { buildContext } from '../test/lambda-test-utilities.js';
import { buildAuthenticatedEvent, setupAuthMocks } from '../test/auth-mocks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_SOCIAL_SUB = 'google-oauth2|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';

function disableMfaEvent() {
  return buildAuthenticatedEvent({ method: 'POST', rawPath: '/api/mfa/disable' });
}

function setupAuth(
  sub: string = MOCK_SUB,
  idTokenPayload: Record<string, unknown> = { amr: ['mfa'] },
) {
  setupAuthMocks({
    ddbMock,
    mockJwtVerify,
    sub,
    userId: MOCK_USER_ID,
    orgId: MOCK_ORG_ID,
    idTokenPayload,
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
    setupAuth();
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
    mockDeleteAllAuthenticators.mockResolvedValue(undefined);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA has been disabled.' }),
    });
    expect(mockDeleteAllAuthenticators).toHaveBeenCalledWith(MOCK_SUB, [
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
  });

  it('disables MFA for social login users', async () => {
    setupAuth(MOCK_SOCIAL_SUB);
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
    mockDeleteAllAuthenticators.mockResolvedValue(undefined);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'MFA has been disabled.' }),
    });
    expect(mockDeleteAllAuthenticators).toHaveBeenCalledWith(MOCK_SOCIAL_SUB, [
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);
  });

  it('returns 400 when MFA is not currently enabled', async () => {
    setupAuth();
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ message: 'MFA is not currently enabled.' }),
    });
    expect(mockDeleteAllAuthenticators).not.toHaveBeenCalled();
  });

  it('returns 401 step_up_required when the ID token has no amr: ["mfa"]', async () => {
    setupAuth(MOCK_SUB, { amr: ['pwd'] });
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'test', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = await handler(disableMfaEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
    expect(mockDeleteAllAuthenticators).not.toHaveBeenCalled();
  });
});
