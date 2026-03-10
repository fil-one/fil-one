import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOCK_USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MOCK_ORG_ID = '11111111-2222-3333-4444-555555555555';
const MOCK_SUB = 'auth0|abc123';
const MOCK_EMAIL = 'user@example.com';
const MOCK_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/setup-queue';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let uuidCallCount = 0;
const MOCK_UUIDS = [MOCK_USER_ID, MOCK_ORG_ID];
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => MOCK_UUIDS[uuidCallCount++] as `${string}-${string}-${string}-${string}-${string}`);

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
const mockDecodeJwt = vi.fn();
const mockCreateRemoteJWKSet = vi.fn((_url: unknown) => 'mock-jwks');

vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: (token: unknown) => mockDecodeJwt(token),
  createRemoteJWKSet: (url: unknown) => mockCreateRemoteJWKSet(url),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ddbMock = mockClient(DynamoDBClient);
const sqsMock = mockClient(SQSClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

// Import after all mocks are set up
import { authMiddleware } from './auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuthRequest = Request<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context,
  Record<string, unknown>
>;

function getUserInfoFromEvent(event: APIGatewayProxyEventV2) {
  return (event as AuthenticatedEvent).requestContext.userInfo;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    sqsMock.reset();
    uuidCallCount = 0;
  });

  describe('before hook', () => {
    it('returns 401 when no cookies are present', async () => {
      const { before } = authMiddleware();
      const request = buildMiddyRequest(buildEvent());

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    it('resolves existing user without enqueuing when tenant setup is complete', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
      });

      ddbMock.on(GetItemCommand, {
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      }).resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: existingUserId },
          orgId: { S: existingOrgId },
          email: { S: MOCK_EMAIL },
        },
      });

      ddbMock.on(GetItemCommand, {
        Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
      }).resolves({
        Item: {
          pk: { S: `ORG#${existingOrgId}` },
          sk: { S: 'PROFILE' },
          name: { S: 'example.com' },
          setupStatus: { S: 'AURORA_TENANT_SETUP_COMPLETE' },
        },
      });

      const { before } = authMiddleware();
      const event = buildEvent({
        cookies: [
          `hs_access_token=valid-token`,
          `hs_id_token=id-token`,
          `hs_refresh_token=refresh-token`,
        ],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
      });
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it('enqueues tenant setup when existing user org setup is not complete', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
      });

      ddbMock.on(GetItemCommand, {
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      }).resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: existingUserId },
          orgId: { S: existingOrgId },
          email: { S: MOCK_EMAIL },
        },
      });

      ddbMock.on(GetItemCommand, {
        Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
      }).resolves({
        Item: {
          pk: { S: `ORG#${existingOrgId}` },
          sk: { S: 'PROFILE' },
          name: { S: 'example.com' },
          setupStatus: { S: 'HYPERSPACE_ORG_CREATED' },
        },
      });

      sqsMock.on(SendMessageCommand).resolves({});

      const { before } = authMiddleware();
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
      });

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(1);
      expect(sqsCalls[0].args[0].input).toStrictEqual({
        QueueUrl: MOCK_QUEUE_URL,
        MessageBody: JSON.stringify({ orgId: existingOrgId, orgName: 'example.com' }),
        MessageGroupId: existingOrgId,
        MessageDeduplicationId: existingOrgId,
      });
    });

    it('creates new user and org when no UserInfoTable record exists', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
      });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({});

      const { before } = authMiddleware();
      const event = buildEvent({ cookies: [`hs_access_token=valid-token`] });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
        email: MOCK_EMAIL,
      });

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(1);
      expect(sqsCalls[0].args[0].input).toStrictEqual({
        QueueUrl: MOCK_QUEUE_URL,
        MessageBody: JSON.stringify({ orgId: MOCK_ORG_ID, orgName: 'example.com' }),
        MessageGroupId: MOCK_ORG_ID,
        MessageDeduplicationId: MOCK_ORG_ID,
      });

      const transactCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
      expect(transactCalls).toHaveLength(1);
      expect(transactCalls[0].args[0].input.TransactItems).toStrictEqual([
        // SUB → identity mapping
        {
          Put: {
            TableName: 'UserInfoTable',
            Item: {
              pk: { S: `SUB#${MOCK_SUB}` },
              sk: { S: 'IDENTITY' },
              userId: { S: MOCK_USER_ID },
              orgId: { S: MOCK_ORG_ID },
              email: { S: MOCK_EMAIL },
              createdAt: { S: expect.any(String) },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        // User profile
        {
          Put: {
            TableName: 'UserInfoTable',
            Item: {
              pk: { S: `USER#${MOCK_USER_ID}` },
              sk: { S: 'PROFILE' },
              sub: { S: MOCK_SUB },
              orgId: { S: MOCK_ORG_ID },
              email: { S: MOCK_EMAIL },
              createdAt: { S: expect.any(String) },
            },
          },
        },
        // Org profile
        {
          Put: {
            TableName: 'UserInfoTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: 'PROFILE' },
              name: { S: 'example.com' },
              setupStatus: { S: 'HYPERSPACE_ORG_CREATED' },
              createdBy: { S: MOCK_USER_ID },
              createdAt: { S: expect.any(String) },
            },
          },
        },
        // Org membership
        {
          Put: {
            TableName: 'UserInfoTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: `MEMBER#${MOCK_USER_ID}` },
              role: { S: 'admin' },
              email: { S: MOCK_EMAIL },
              joinedAt: { S: expect.any(String) },
            },
          },
        },
      ]);
    });

    it('refreshes tokens when access token is expired but refresh token is valid', async () => {
      const existingUserId = 'refreshed-user-uuid';
      const existingOrgId = 'refreshed-org-uuid';

      mockJwtVerify.mockRejectedValue(new Error('token expired'));

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          refresh_token: 'new-refresh-token',
        }),
      });

      mockDecodeJwt.mockReturnValue({
        sub: MOCK_SUB,
        email: MOCK_EMAIL,
      });

      ddbMock.on(GetItemCommand).resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: existingUserId },
          orgId: { S: existingOrgId },
        },
      });

      const { before } = authMiddleware();
      const event = buildEvent({
        cookies: [
          `hs_access_token=expired-token`,
          `hs_refresh_token=valid-refresh`,
        ],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
      });
      expect(request.internal.newTokens).toEqual({
        access_token: 'new-access-token',
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
      });
    });

    it('returns 401 when access token expired and refresh fails', async () => {
      mockJwtVerify.mockRejectedValue(new Error('token expired'));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'invalid refresh token',
      });

      const { before } = authMiddleware();
      const request = buildMiddyRequest(buildEvent({
        cookies: [
          `hs_access_token=expired`,
          `hs_refresh_token=bad-refresh`,
        ],
      }));

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    it('returns 401 when access token expired and refresh fetch throws', async () => {
      mockJwtVerify.mockRejectedValue(new Error('token expired'));
      mockFetch.mockRejectedValue(new Error('network error'));

      const { before } = authMiddleware();
      const request = buildMiddyRequest(buildEvent({
        cookies: [
          `hs_access_token=expired`,
          `hs_refresh_token=some-refresh`,
        ],
      }));

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    it('parses cookies from event.cookies array correctly', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
      });

      ddbMock.on(GetItemCommand).resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: 'some-user' },
          orgId: { S: 'some-org' },
        },
      });

      const { before } = authMiddleware();
      const request = buildMiddyRequest(buildEvent({
        cookies: [' hs_access_token = my-token '],
      }));

      await before(request);

      expect(mockJwtVerify).toHaveBeenCalledWith(
        'my-token',
        'mock-jwks',
        { audience: process.env.AUTH0_AUDIENCE, issuer: `https://${process.env.AUTH0_DOMAIN}/` },
      );
    });
  });

  describe('after hook', () => {
    it('attaches Set-Cookie headers when newTokens exist', async () => {
      const { after } = authMiddleware();
      const response: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: '{}' };
      const request: AuthRequest = {
        event: buildEvent(),
        context: {} as Context,
        response,
        error: undefined,
        internal: {
          newTokens: {
            access_token: 'new-at',
            id_token: 'new-it',
            refresh_token: 'new-rt',
          },
        },
      };

      await after(request);

      const cookies = response.cookies ?? [];
      expect(cookies).toHaveLength(5);
      expect(cookies[0]).toBe('hs_access_token=new-at; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[1]).toBe('hs_id_token=new-it; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[2]).toBe('hs_refresh_token=new-rt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[3]).toBe('hs_logged_in=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[4]).toMatch(/^hs_csrf_token=[a-f0-9-]+; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/)
    });

    it('does not modify response when no newTokens', async () => {
      const { after } = authMiddleware();
      const response: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: '{}' };
      const request: AuthRequest = {
        event: buildEvent(),
        context: {} as Context,
        response,
        error: undefined,
        internal: {},
      };

      await after(request);

      expect(response.cookies).toBeUndefined();
    });
  });
});
