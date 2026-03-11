import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
    AuroraBackofficeToken: { value: 'test-aurora-token' },
    AuroraTenantSetupQueue: { url: 'https://sqs.us-east-1.amazonaws.com/123/setup-queue' },
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
const sqsMock = mockClient(SQSClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './get-me.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';

function authenticatedEvent() {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/me handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
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
          email: { S: MOCK_EMAIL },
        },
      });
  });

  it('returns orgSetupComplete: true when setupStatus is AURORA_TENANT_API_KEY_CREATED', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          setupStatus: { S: 'AURORA_TENANT_API_KEY_CREATED' },
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        email: MOCK_EMAIL,
        orgSetupComplete: true,
      }),
    });
  });

  it('returns orgSetupComplete: false when setupStatus is HYPERSPACE_ORG_CREATED', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
          setupStatus: { S: 'HYPERSPACE_ORG_CREATED' },
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        email: MOCK_EMAIL,
        orgSetupComplete: false,
      }),
    });
  });

  it('returns orgSetupComplete: false when setupStatus is missing', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'Example Corp' },
          orgConfirmed: { BOOL: true },
        },
      });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Example Corp',
        orgConfirmed: true,
        email: MOCK_EMAIL,
        orgSetupComplete: false,
      }),
    });
  });
});
