import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    UploadsTable: { name: 'UploadsTable' },
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
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

import { handler } from './get-usage.js';
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
    cookies: ['hs_access_token=valid-token'],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
  });
}

/** Set up the auth middleware identity + org profile lookups. */
function mockAuthIdentity() {
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

  // Auth middleware also checks org profile for org-confirmed gate
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: 'Test Org' },
        orgConfirmed: { BOOL: true },
      },
    });
}

/** Mock the buckets query to return the given bucket names. */
function mockBuckets(bucketNames: string[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'UploadsTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${MOCK_USER_ID}` },
        ':skPrefix': { S: 'BUCKET#' },
      },
    })
    .resolves({
      Items: bucketNames.map((name) =>
        marshall({
          pk: `USER#${MOCK_USER_ID}`,
          sk: `BUCKET#${name}`,
          name,
          region: 'us-east-1',
          createdAt: '2024-01-01T00:00:00Z',
          isPublic: false,
        }),
      ),
    });
}

/** Mock the objects query for a specific bucket. */
function mockBucketObjects(bucketName: string, objects: { sizeBytes: number }[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'UploadsTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `BUCKET#${MOCK_USER_ID}#${bucketName}` },
        ':skPrefix': { S: 'OBJECT#' },
      },
    })
    .resolves({
      Items: objects.map((obj) => marshall(obj)),
    });
}

/** Mock the access keys count query. */
function mockAccessKeys(count: number) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${MOCK_ORG_ID}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    })
    .resolves({ Count: count });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/usage handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
    });
    mockAuthIdentity();
  });

  it('returns usage data with no buckets and no keys', async () => {
    mockBuckets([]);
    mockAccessKeys(0);

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 0 },
        egress: { usedBytes: 0 },
        buckets: { count: 0, limit: 100 },
        objects: { count: 0 },
        accessKeys: { count: 0, limit: 300 },
      }),
    });
  });

  it('sums storage across multiple buckets and objects', async () => {
    mockBuckets(['photos', 'docs']);
    mockBucketObjects('photos', [{ sizeBytes: 1000 }, { sizeBytes: 2500 }]);
    mockBucketObjects('docs', [{ sizeBytes: 500 }]);
    mockAccessKeys(3);

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 4000 },
        egress: { usedBytes: 0 },
        buckets: { count: 2, limit: 100 },
        objects: { count: 3 },
        accessKeys: { count: 3, limit: 300 },
      }),
    });
  });

  it('handles a bucket with no objects', async () => {
    mockBuckets(['empty-bucket']);
    mockBucketObjects('empty-bucket', []);
    mockAccessKeys(1);

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 0 },
        egress: { usedBytes: 0 },
        buckets: { count: 1, limit: 100 },
        objects: { count: 0 },
        accessKeys: { count: 1, limit: 300 },
      }),
    });
  });
});
