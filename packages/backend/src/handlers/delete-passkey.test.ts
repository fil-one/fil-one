import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPasskeyAuthenticators = vi.fn();
const mockDeleteAuthenticationMethod = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
  getPasskeyAuthenticators: (...args: unknown[]) => mockGetPasskeyAuthenticators(...args),
  deleteAuthenticationMethod: (...args: unknown[]) => mockDeleteAuthenticationMethod(...args),
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

import { handler } from './delete-passkey.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';
const MOCK_PASSKEY_ID = 'passkey|dev_abc';

function deletePasskeyEvent(methodId: string = MOCK_PASSKEY_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: MOCK_SUB },
    method: 'DELETE',
    rawPath: `/api/mfa/passkeys/${methodId}`,
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  (event as unknown as Record<string, unknown>).pathParameters = { methodId };
  return event;
}

function setupAuthMocks(idTokenPayload: Record<string, unknown> = { amr: ['mfa'] }) {
  mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } }).mockResolvedValueOnce({
    payload: { email: MOCK_EMAIL, email_verified: true, ...idTokenPayload },
  });

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

describe('DELETE /api/mfa/passkeys/{methodId} handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('deletes the passkey when it belongs to the user and amr includes mfa', async () => {
    setupAuthMocks();
    mockGetPasskeyAuthenticators.mockResolvedValue([
      { id: MOCK_PASSKEY_ID, name: 'iPhone', created_at: '2026-05-01T00:00:00Z' },
    ]);
    mockDeleteAuthenticationMethod.mockResolvedValue(undefined);

    const result = await handler(deletePasskeyEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ message: 'Passkey removed.' }),
    });
    expect(mockDeleteAuthenticationMethod).toHaveBeenCalledWith(MOCK_SUB, MOCK_PASSKEY_ID);
  });

  it('returns 401 step_up_required when the ID token has no amr: ["mfa" | "phr"]', async () => {
    setupAuthMocks({ amr: ['pwd'] });

    const result = await handler(deletePasskeyEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
    expect(mockGetPasskeyAuthenticators).not.toHaveBeenCalled();
    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
  });

  it('returns 404 when the passkey does not belong to the user', async () => {
    setupAuthMocks();
    mockGetPasskeyAuthenticators.mockResolvedValue([
      { id: 'passkey|someone_else', name: 'Other', created_at: '2026-05-01T00:00:00Z' },
    ]);

    const result = await handler(deletePasskeyEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ message: 'Passkey not found.' }),
    });
    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
  });

  it('returns 404 when the user has no passkeys', async () => {
    setupAuthMocks();
    mockGetPasskeyAuthenticators.mockResolvedValue([]);

    const result = await handler(deletePasskeyEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ message: 'Passkey not found.' }),
    });
    expect(mockDeleteAuthenticationMethod).not.toHaveBeenCalled();
  });
});
