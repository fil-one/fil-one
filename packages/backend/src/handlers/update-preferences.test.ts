import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateSubscriptionStatus = vi.fn();
vi.mock('../lib/hubspot-client.js', () => ({
  HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID: 2233676376,
  updateSubscriptionStatus: (...args: unknown[]) => mockUpdateSubscriptionStatus(...args),
}));

const MARKETING_SUBSCRIPTION_ID = 2233676376;

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
    mockUpdateSubscriptionStatus.mockResolvedValue(undefined);

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
  });

  it('syncs opt-out to HubSpot and returns the new preference', async () => {
    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: false }),
      buildContext(),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ marketingEmailsOptedIn: false }),
    });

    expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
      MOCK_EMAIL,
      MARKETING_SUBSCRIPTION_ID,
      false,
    );
  });

  it('syncs opt-in to HubSpot and returns the new preference', async () => {
    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: true }),
      buildContext(),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ marketingEmailsOptedIn: true }),
    });

    expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
      MOCK_EMAIL,
      MARKETING_SUBSCRIPTION_ID,
      true,
    );
  });

  it('returns 5xx when HubSpot sync fails', async () => {
    mockUpdateSubscriptionStatus.mockRejectedValue(new Error('HubSpot API down'));

    const result = await handler(
      preferencesEvent({ marketingEmailsOptedIn: false }),
      buildContext(),
    );

    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('returns 400 when the authenticated user has no email', async () => {
    // Auth middleware derives email from the JWT; omit it from the payload here.
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email_verified: true },
    });

    const event = buildEvent({
      cookies: [
        `hs_access_token=valid-token`,
        `hs_id_token=id-token`,
        `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
      ],
      userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID },
      body: JSON.stringify({ marketingEmailsOptedIn: true }),
      method: 'PATCH',
      rawPath: '/api/me/preferences',
    });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
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
