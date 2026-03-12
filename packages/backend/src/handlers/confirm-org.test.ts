import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { OrgSetupStatus } from '../lib/org-setup-status.js';
import { ORG_NAME_MIN_LENGTH, ORG_NAME_MAX_LENGTH } from '../lib/org-name-validation.js';

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

import { handler } from './confirm-org.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';
const MOCK_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/setup-queue';

function confirmOrgEvent(body: unknown) {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_csrf_token=${MOCK_CSRF_TOKEN}`],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
    body: JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/org/confirm',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/org/confirm handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    sqsMock.reset();

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

    // Auth middleware: org profile (not yet confirmed — this route is in bypass list)
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: {
          pk: { S: `ORG#${MOCK_ORG_ID}` },
          sk: { S: 'PROFILE' },
          name: { S: 'example.com' },
          orgConfirmed: { BOOL: false },
          setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
        },
      });

    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: 'Acme Corp' },
        orgConfirmed: { BOOL: true },
        setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
      },
    });
    sqsMock.on(SendMessageCommand).resolves({});
  });

  it('confirms org and enqueues tenant setup', async () => {
    const event = confirmOrgEvent({ orgName: 'Acme Corp' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        orgId: MOCK_ORG_ID,
        orgName: 'Acme Corp',
      }),
    });

    // Verify DDB update with ConditionExpression and ReturnValues
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
      },
      UpdateExpression: 'SET #name = :name, orgConfirmed = :confirmed',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':name': { S: 'Acme Corp' },
        ':confirmed': { BOOL: true },
      },
      ReturnValues: 'ALL_NEW',
    });

    // Verify SQS enqueue
    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sqsCalls).toHaveLength(1);
    expect(sqsCalls[0].args[0].input).toStrictEqual({
      QueueUrl: MOCK_QUEUE_URL,
      MessageBody: JSON.stringify({ orgId: MOCK_ORG_ID, orgName: 'Acme Corp' }),
      MessageGroupId: MOCK_ORG_ID,
      MessageDeduplicationId: MOCK_ORG_ID,
    });
  });

  it('skips SQS enqueue when Aurora tenant setup is already complete', async () => {
    // Override UpdateItemCommand to return setup-complete status
    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: 'Acme Corp' },
        orgConfirmed: { BOOL: true },
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
      },
    });

    const event = confirmOrgEvent({ orgName: 'Acme Corp' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 200 });

    // Should NOT enqueue because setup is already complete
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 when orgName is missing', async () => {
    const event = confirmOrgEvent({});
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('Organization name must be a string'),
    });

    // Should NOT update DDB or enqueue SQS
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 when orgName is too short', async () => {
    const event = confirmOrgEvent({ orgName: 'A' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining(`at least ${ORG_NAME_MIN_LENGTH} characters`),
    });

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 when orgName exceeds max length', async () => {
    const event = confirmOrgEvent({ orgName: 'A'.repeat(ORG_NAME_MAX_LENGTH + 1) });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining(`at most ${ORG_NAME_MAX_LENGTH} characters`),
    });

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 when orgName is not a string', async () => {
    const event = confirmOrgEvent({ orgName: 123 });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('Organization name must be a string'),
    });
  });

  it('sanitizes HTML in orgName', async () => {
    const event = confirmOrgEvent({ orgName: '<script>alert("xss")</script>Acme' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 200 });

    // The sanitized name should have HTML entities escaped
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    const savedName = updateCalls[0].args[0].input.ExpressionAttributeValues![':name'].S!;
    expect(savedName).not.toContain('<script>');
    expect(savedName).toContain('&lt;');
  });

  it('trims whitespace from orgName', async () => {
    const event = confirmOrgEvent({ orgName: '  Acme Corp  ' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    const body = JSON.parse((result as { body: string }).body);
    expect(body.orgName).toBe('Acme Corp');
  });

  it('returns 500 when org profile does not exist (condition check fails)', async () => {
    const conditionError = new Error('The conditional request failed');
    conditionError.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateItemCommand).rejects(conditionError);

    const event = confirmOrgEvent({ orgName: 'Acme Corp' });
    event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;

    const result = await handler(event, buildContext());

    // Error handler middleware catches the unhandled error and returns 500
    expect(result).toMatchObject({ statusCode: 500 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 403 when CSRF token is missing', async () => {
    const event = confirmOrgEvent({ orgName: 'Acme Corp' });
    // Intentionally NOT setting x-csrf-token header

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('returns 403 when CSRF token does not match cookie', async () => {
    const event = confirmOrgEvent({ orgName: 'Acme Corp' });
    event.headers['x-csrf-token'] = 'wrong-token';

    const result = await handler(event, buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});
