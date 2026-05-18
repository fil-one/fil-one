import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSyncMarketingPreference = vi.fn();
vi.mock('../lib/hubspot-client.js', () => ({
  syncMarketingPreference: (...args: unknown[]) => mockSyncMarketingPreference(...args),
}));

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
    AuroraBackofficeToken: { value: 'test-aurora-token' },
    HubSpotServiceKey: { value: 'test-hubspot-key' },
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

import { handler } from './update-preferences.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function preferencesEvent(body: unknown) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
    body: JSON.stringify(body),
    method: 'PATCH',
    rawPath: '/api/me/preferences',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/me/preferences handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockSyncMarketingPreference.mockResolvedValue(undefined);

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

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
        },
      });

    // Auth middleware: org confirmed
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

  it('updates preference to false and syncs to HubSpot', async () => {
    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: false }),
      buildContext(),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ marketingEmailsOptedIn: false }),
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: `USER#${MOCK_USER_ID}` }, sk: { S: 'PROFILE' } },
      ExpressionAttributeValues: { ':val': { BOOL: false } },
    });

    expect(mockSyncMarketingPreference).toHaveBeenCalledWith(MOCK_EMAIL, false);
  });

  it('updates preference to true and syncs to HubSpot', async () => {
    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: true }),
      buildContext(),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ marketingEmailsOptedIn: true }),
    });

    expect(mockSyncMarketingPreference).toHaveBeenCalledWith(MOCK_EMAIL, true);
  });

  it('fails the request and skips the DDB write when HubSpot sync fails', async () => {
    mockSyncMarketingPreference.mockRejectedValue(new Error('HubSpot API down'));

    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: false }),
      buildContext(),
    );

    expect(result).toMatchObject({ statusCode: 500 });

    // DynamoDB was NOT updated — HubSpot is the gating step
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({
      cookies: [
        `hs_access_token=valid-token`,
        `hs_id_token=id-token`,
        `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
      ],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
      body: 'not-json{',
      method: 'PATCH',
      rawPath: '/api/me/preferences',
    });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when marketingEmailsOptedIn is not a boolean', async () => {
    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: 'yes' }),
      buildContext(),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when body is empty', async () => {
    const result = await handler(preferencesEvent({}), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 403 when CSRF token is missing', async () => {
    const event = buildEvent({
      cookies: [
        `hs_access_token=valid-token`,
        `hs_id_token=id-token`,
        `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
      ],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
      body: JSON.stringify({ marketingEmailsOptedIn: false }),
      method: 'PATCH',
      rawPath: '/api/me/preferences',
    });
    // Intentionally not setting x-csrf-token header

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
  });
});
