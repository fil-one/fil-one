import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

// The cookie path is authMiddleware's own concern (it has dedicated tests);
// here we only assert the dispatcher delegates to it — and ONLY when no
// Authorization header is present.
const mockCookieBefore = vi.fn();
const mockCookieAfter = vi.fn();
vi.mock('./auth.js', () => ({
  authMiddleware: vi.fn(() => ({ before: mockCookieBefore, after: mockCookieAfter })),
}));

import { ragQueryAuthMiddleware } from './rag-query-auth.js';
import { hashRagKeyToken, RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import type { UserInfo } from '../lib/user-context.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const ddbMock = mockClient(DynamoDBClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = 'sk_rag_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const TOKEN_HASH = hashRagKeyToken(TOKEN);
const KEY_ID = 'key-1';
const ORG_ID = 'org-A';

const ORG_RECORD = {
  pk: RagApiKeyKeys.orgPk(ORG_ID),
  sk: RagApiKeyKeys.orgSk(KEY_ID),
  keyName: 'ci key',
  keyPrefix: TOKEN.slice(0, 12),
  tokenHash: TOKEN_HASH,
  bucketScope: 'all',
  createdBy: 'user-creator',
  creatorEmail: 'creator@example.com',
  createdAt: '2026-07-01T00:00:00Z',
};

function stubKeyRecords(orgRecordOverrides: Record<string, unknown> = {}) {
  ddbMock
    .on(GetItemCommand, {
      Key: { pk: { S: RagApiKeyKeys.lookupPk(TOKEN_HASH) }, sk: { S: RagApiKeyKeys.lookupSk() } },
    })
    .resolves({ Item: marshall({ orgId: ORG_ID, keyId: KEY_ID }) });
  ddbMock
    .on(GetItemCommand, {
      Key: { pk: { S: RagApiKeyKeys.orgPk(ORG_ID) }, sk: { S: RagApiKeyKeys.orgSk(KEY_ID) } },
    })
    .resolves({ Item: marshall({ ...ORG_RECORD, ...orgRecordOverrides }) });
  ddbMock.on(UpdateItemCommand).resolves({});
}

function bearerEvent({
  authorization,
  bucketName = 'my-bucket',
  region,
}: {
  authorization?: string;
  bucketName?: string;
  region?: string;
} = {}): APIGatewayProxyEventV2 {
  const event = buildEvent({
    ...(region ? { queryStringParameters: { region } } : {}),
  });
  if (authorization !== undefined) event.headers.authorization = authorization;
  event.pathParameters = { name: bucketName };
  return event;
}

function getUserInfo(event: APIGatewayProxyEventV2): UserInfo | undefined {
  return (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo?: UserInfo }
  ).userInfo;
}

async function runBefore(event: APIGatewayProxyEventV2) {
  const middleware = ragQueryAuthMiddleware();
  const request = buildMiddyRequest(event);
  const response = (await middleware.before(request as Parameters<typeof middleware.before>[0])) as
    | APIGatewayProxyStructuredResultV2
    | undefined;
  return { middleware, request, response };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ragQueryAuthMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('dispatch', () => {
    it('delegates to the cookie middleware when no Authorization header is present', async () => {
      const event = bearerEvent();
      const { middleware, request } = await runBefore(event);

      expect(mockCookieBefore).toHaveBeenCalledOnce();
      expect(ddbMock.calls()).toHaveLength(0);

      await middleware.after(request as Parameters<typeof middleware.after>[0]);
      expect(mockCookieAfter).toHaveBeenCalledOnce();
    });

    it('never falls back to cookies when an Authorization header is present', async () => {
      const { middleware, request, response } = await runBefore(
        bearerEvent({ authorization: 'Bearer not-a-rag-token' }),
      );

      expect(response?.statusCode).toBe(401);
      expect(mockCookieBefore).not.toHaveBeenCalled();

      await middleware.after(request as Parameters<typeof middleware.after>[0]);
      expect(mockCookieAfter).not.toHaveBeenCalled();
    });
  });

  describe('bearer failures', () => {
    it.each([
      ['empty header', ''],
      ['not bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['wrong token prefix', 'Bearer sk-live_0123456789abcdefghijklmnop'],
      ['token too short', 'Bearer sk_rag_short'],
      ['trailing content', `Bearer ${TOKEN} extra`],
    ])('rejects %s with 401 without touching DynamoDB', async (_label, authorization) => {
      const { response } = await runBefore(bearerEvent({ authorization }));

      expect(response?.statusCode).toBe(401);
      expect(JSON.parse(response?.body ?? '{}')).toEqual({ message: 'Unauthorized' });
      expect(ddbMock.calls()).toHaveLength(0);
    });

    it('rejects a well-formed but unknown token with 401', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));
      expect(response?.statusCode).toBe(401);
    });

    it('rejects an orphaned lookup row (org record missing) with 401', async () => {
      ddbMock
        .on(GetItemCommand, {
          Key: {
            pk: { S: RagApiKeyKeys.lookupPk(TOKEN_HASH) },
            sk: { S: RagApiKeyKeys.lookupSk() },
          },
        })
        .resolves({ Item: marshall({ orgId: ORG_ID, keyId: KEY_ID }) });
      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: RagApiKeyKeys.orgPk(ORG_ID) }, sk: { S: RagApiKeyKeys.orgSk(KEY_ID) } },
        })
        .resolves({});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      expect(response?.statusCode).toBe(401);
      // Diagnostics must identify the key without leaking the credential.
      expect(errorSpy).toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
    });
  });

  describe('bearer success', () => {
    it('attaches synthetic userInfo built from the key record (scope=all)', async () => {
      stubKeyRecords();
      const event = bearerEvent({ authorization: `Bearer ${TOKEN}` });

      const { response } = await runBefore(event);

      expect(response).toBeUndefined();
      expect(getUserInfo(event)).toEqual({
        sub: `ragkey|${KEY_ID}`,
        userId: 'user-creator',
        orgId: ORG_ID,
        email: 'creator@example.com',
        emailVerified: true,
        name: 'ci key',
      });
    });

    it('derives orgId only from the key record, ignoring request-supplied identity', async () => {
      stubKeyRecords();
      const event = bearerEvent({ authorization: `Bearer ${TOKEN}` });
      // An attacker-controlled body/header can name any org — it must not matter.
      event.headers['x-org-id'] = 'org-B';
      event.body = JSON.stringify({ orgId: 'org-B' });

      await runBefore(event);

      expect(getUserInfo(event)?.orgId).toBe(ORG_ID);
    });

    it('strips the authorization header after successful auth', async () => {
      stubKeyRecords();
      const event = bearerEvent({ authorization: `Bearer ${TOKEN}` });

      await runBefore(event);

      expect(event.headers.authorization).toBeUndefined();
    });

    it('accepts a case-insensitive bearer scheme', async () => {
      stubKeyRecords();
      const { response } = await runBefore(bearerEvent({ authorization: `bearer ${TOKEN}` }));
      expect(response).toBeUndefined();
    });

    it('stamps lastUsedAt on the org record', async () => {
      stubKeyRecords();
      await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      const updates = ddbMock.commandCalls(UpdateItemCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.Key).toEqual({
        pk: { S: RagApiKeyKeys.orgPk(ORG_ID) },
        sk: { S: RagApiKeyKeys.orgSk(KEY_ID) },
      });
    });

    it('does not fail the request when the lastUsedAt update fails', async () => {
      stubKeyRecords();
      ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      expect(response).toBeUndefined();
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TOKEN);
    });
  });

  describe('bucket scope', () => {
    const SCOPED = {
      bucketScope: 'specific',
      buckets: [
        { region: 'eu-west-1', name: 'allowed-bucket' },
        { region: 'us-east-1', name: 'other-bucket' },
      ],
    };

    it('allows a scoped bucket in the matching region', async () => {
      stubKeyRecords(SCOPED);
      const { response } = await runBefore(
        bearerEvent({
          authorization: `Bearer ${TOKEN}`,
          bucketName: 'allowed-bucket',
          region: 'eu-west-1',
        }),
      );
      expect(response).toBeUndefined();
    });

    it('defaults the region to eu-west-1 like the query handler', async () => {
      stubKeyRecords(SCOPED);
      const { response } = await runBefore(
        bearerEvent({ authorization: `Bearer ${TOKEN}`, bucketName: 'allowed-bucket' }),
      );
      expect(response).toBeUndefined();
    });

    it.each([
      ['bucket not in scope', 'unrelated-bucket', 'eu-west-1'],
      ['right name, wrong region', 'allowed-bucket', 'us-east-1'],
      ['right region, wrong name', 'other-bucket', 'eu-west-1'],
    ])('returns 404 for %s (indistinguishable from nonexistent)', async (_label, name, region) => {
      stubKeyRecords(SCOPED);
      const { response } = await runBefore(
        bearerEvent({ authorization: `Bearer ${TOKEN}`, bucketName: name, region }),
      );

      expect(response?.statusCode).toBe(404);
      expect(JSON.parse(response?.body ?? '{}')).toEqual({ message: 'Bucket not found' });
      // Denied before userInfo attachment — nothing downstream can run as this org.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });
});
