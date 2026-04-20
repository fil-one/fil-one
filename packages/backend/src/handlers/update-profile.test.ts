import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateAuth0User = vi.fn();
const mockSendVerificationEmail = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  updateAuth0User: (...args: unknown[]) => mockUpdateAuth0User(...args),
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
  getConnectionType: (sub: string) => sub.split('|')[0] ?? 'unknown',
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

import { handler } from './update-profile.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function profileEvent(body: unknown) {
  const event = buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_csrf_token=${MOCK_CSRF_TOKEN}`],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
    body: JSON.stringify(body),
    method: 'PATCH',
    rawPath: '/api/me/profile',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/me/profile handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockUpdateAuth0User.mockResolvedValue(undefined);
    mockSendVerificationEmail.mockResolvedValue(undefined);

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

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

    ddbMock.on(UpdateItemCommand).resolves({});
  });

  it('updates orgName in DynamoDB', async () => {
    const result = await handler(profileEvent({ orgName: 'New Corp' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ orgName: 'New Corp' }),
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      ExpressionAttributeValues: { ':name': { S: 'New Corp' } },
    });
  });

  it('updates name via Auth0 Management API for database users', async () => {
    const result = await handler(profileEvent({ name: 'New Name' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(mockUpdateAuth0User).toHaveBeenCalledWith(MOCK_SUB, { name: 'New Name' });
  });

  it('updates email via Auth0 and sends verification email', async () => {
    const result = await handler(profileEvent({ email: 'new@example.com' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(mockUpdateAuth0User).toHaveBeenCalledWith(MOCK_SUB, {
      email: 'new@example.com',
      email_verified: false,
    });
    expect(mockSendVerificationEmail).toHaveBeenCalledWith(MOCK_SUB);
  });

  it('rejects name change for social login users', async () => {
    const socialSub = 'google-oauth2|123';
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
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
        },
      });

    const event = buildEvent({
      cookies: [`hs_access_token=valid-token`, `hs_csrf_token=${MOCK_CSRF_TOKEN}`],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: socialSub },
      body: JSON.stringify({ name: 'New Name' }),
      method: 'PATCH',
      rawPath: '/api/me/profile',
    });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockUpdateAuth0User).not.toHaveBeenCalled();
  });

  it('rejects email change for social login users', async () => {
    const socialSub = 'google-oauth2|123';
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
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
        },
      });

    const event = buildEvent({
      cookies: [`hs_access_token=valid-token`, `hs_csrf_token=${MOCK_CSRF_TOKEN}`],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL, sub: socialSub },
      body: JSON.stringify({ email: 'new@example.com' }),
      method: 'PATCH',
      rawPath: '/api/me/profile',
    });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockUpdateAuth0User).not.toHaveBeenCalled();
  });

  it('returns 400 when no fields are provided', async () => {
    const result = await handler(profileEvent({}), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for invalid email', async () => {
    const result = await handler(profileEvent({ email: 'not-an-email' }), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for empty name', async () => {
    const result = await handler(profileEvent({ name: '' }), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for too-short orgName', async () => {
    const result = await handler(profileEvent({ orgName: 'A' }), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when orgName contains special characters', async () => {
    const result = await handler(profileEvent({ orgName: 'Acme @Corp!' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('letters, numbers, spaces, hyphens, and periods'),
    });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('accepts orgName with dots and hyphens', async () => {
    const result = await handler(profileEvent({ orgName: 'Acme-Corp Inc.' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ orgName: 'Acme-Corp Inc.' }),
    });
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({
      cookies: [`hs_access_token=valid-token`, `hs_csrf_token=${MOCK_CSRF_TOKEN}`],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
      body: 'not-json{',
      method: 'PATCH',
      rawPath: '/api/me/profile',
    });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('still returns 200 when email is updated but sendVerificationEmail fails', async () => {
    mockSendVerificationEmail.mockRejectedValue(new Error('Auth0 verification email failed'));

    const result = await handler(profileEvent({ email: 'new@example.com' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(mockUpdateAuth0User).toHaveBeenCalledWith(MOCK_SUB, {
      email: 'new@example.com',
      email_verified: false,
    });
  });
});
