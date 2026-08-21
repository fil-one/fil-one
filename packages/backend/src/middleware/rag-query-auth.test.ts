import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    OrgTable: { name: 'OrgTable' },
  },
}));

// The cookie path is authMiddleware's own concern (it has dedicated tests);
// here we only assert the dispatcher delegates to it — and ONLY when no
// Authorization header is present.
const mockCookieBefore = vi.fn();
const mockCookieAfter = vi.fn();
vi.mock('./auth.js', () => ({
  authMiddleware: vi.fn(() => ({ before: mockCookieBefore, after: mockCookieAfter })),
  withRefreshedCookies: (
    _request: unknown,
    response: APIGatewayProxyStructuredResultV2,
  ): APIGatewayProxyStructuredResultV2 => response,
  // The bearer path answers a failed membership read with the cookie path's own
  // 503; only its status matters here.
  membershipUnavailableResponse: (): APIGatewayProxyStructuredResultV2 => ({
    statusCode: 503,
    body: JSON.stringify({ message: 'We could not read your organization membership.' }),
  }),
}));

import { ApiErrorCode, OrgRole } from '@filone/shared';
import { ragQueryAuthMiddleware } from './rag-query-auth.js';
import { hashRagKeyToken, RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { OrgKeys } from '../lib/org-membership.js';
import {
  buildEvent,
  buildMiddyRequest,
  membershipFor,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const ddbMock = mockClient(DynamoDBClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = 'sk_rag_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const TOKEN_HASH = hashRagKeyToken(TOKEN);
const KEY_ID = 'key-1';
const ORG_ID = 'org-A';
const CREATOR_ID = 'user-creator';

const ORG_RECORD = {
  pk: RagApiKeyKeys.orgPk(ORG_ID),
  sk: RagApiKeyKeys.orgSk(KEY_ID),
  keyName: 'ci key',
  keyPrefix: TOKEN.slice(0, 12),
  tokenHash: TOKEN_HASH,
  bucketScope: 'all',
  createdBy: CREATOR_ID,
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
  // The deletion fence, read after the key resolves.
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } } })
    .resolves({ Item: { pk: { S: `ORG#${ORG_ID}` } } });
  // The key's authority is its creator's membership, and the default creator
  // is still in the org.
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: CREATOR_ID, role: OrgRole.Member });
  ddbMock.on(UpdateItemCommand).resolves({});
}

function stubOrgDeleting() {
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } } })
    .resolves({ Item: { pk: { S: `ORG#${ORG_ID}` }, deleting: { BOOL: true } } });
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
  // The manifest's cookieRequires for POST /api/buckets/{name}/query.
  const middleware = ragQueryAuthMiddleware({ cookieRequires: 'buckets.read' });
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
    // Implementations, not just call records: the cookie-path tests install
    // their own `before`, and a leftover one makes the next test's result
    // depend on file order. Reset targets these two rather than every mock,
    // because the module factory's own vi.fn is what returns them.
    mockCookieBefore.mockReset();
    mockCookieAfter.mockReset();
    ddbMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('dispatch', () => {
    it('delegates to the cookie middleware when no Authorization header is present', async () => {
      const event = buildEvent({ userInfo: { userId: 'console-user', orgId: ORG_ID } });
      event.pathParameters = { name: 'my-bucket' };
      const { middleware, request } = await runBefore(event);

      expect(mockCookieBefore).toHaveBeenCalledOnce();
      // The cookie middleware makes the reads; this one adds none of its own.
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
    // A RAG key has no session behind it, so the SUB# tombstone that kills
    // cookie auth never applies — this is the only fence it meets.
    it('410s a valid key whose org is being deleted', async () => {
      stubKeyRecords();
      stubOrgDeleting();

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      expect(response?.statusCode).toBe(410);
      expect(JSON.parse((response?.body as string) ?? '{}').code).toBe(
        ApiErrorCode.ACCOUNT_DELETED,
      );
    });

    it('attaches synthetic userInfo built from the key record (scope=all)', async () => {
      stubKeyRecords();
      const event = bearerEvent({ authorization: `Bearer ${TOKEN}` });

      const { response } = await runBefore(event);

      expect(response).toBeUndefined();
      expect(getUserInfo(event)).toEqual({
        sub: `ragkey|${KEY_ID}`,
        userId: CREATOR_ID,
        orgId: ORG_ID,
        email: 'creator@example.com',
        emailVerified: true,
        name: 'ci key',
        // Says out loud that `sub` names a key rather than a person: the
        // subscription guard reads it and provisions no trial.
        apiKeySession: true,
        // The creator's row, so downstream reads see a real role rather than a
        // caller with no membership at all.
        membership: membershipFor(ORG_ID, CREATOR_ID, OrgRole.Member),
      });
    });

    it('reads the creator membership consistently, like the cookie path', async () => {
      stubKeyRecords();
      await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      const membershipRead = ddbMock
        .commandCalls(GetItemCommand)
        .map((call) => call.args[0].input)
        .find((input) => input.TableName === 'OrgTable');
      expect(membershipRead).toMatchObject({
        Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(CREATOR_ID) } },
        ConsistentRead: true,
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

  describe('the creator membership behind a bearer token', () => {
    it('refuses a key whose creator is no longer a member', async () => {
      stubKeyRecords();
      stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: CREATOR_ID });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      expect(response?.statusCode).toBe(403);
      expect(JSON.parse(response?.body ?? '{}')).toEqual({
        message: 'You are not a member of this organization.',
        code: ApiErrorCode.NOT_A_MEMBER,
      });
      // A dead key leaves no trace of having worked.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('counts the denial apart from an account the conversion missed', async () => {
      stubKeyRecords();
      stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: CREATOR_ID });
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      // NotAMemberDenialCount is the conversion's lockout alarm; a revoked key
      // creator is the design working and must not read as one.
      const emitted = written.join('');
      expect(emitted).toContain('RevokedKeyCreatorDenialCount');
      expect(emitted).not.toContain('NotAMemberDenialCount');
    });

    it('answers a failed membership read with a retryable 503, not a revocation', async () => {
      // An OrgTable outage read as an absent row would revoke every live key
      // for its duration. Same answer the cookie path gives.
      stubKeyRecords();
      ddbMock
        .on(GetItemCommand, {
          TableName: 'OrgTable',
          Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(CREATOR_ID) } },
        })
        .rejects(new Error('throttled'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { response } = await runBefore(bearerEvent({ authorization: `Bearer ${TOKEN}` }));

      expect(response?.statusCode).toBe(503);
      // Nothing ran as this key: no last-used stamp, no downstream chain.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('strips the credential even on the denial', async () => {
      stubKeyRecords();
      stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: CREATOR_ID });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const event = bearerEvent({ authorization: `Bearer ${TOKEN}` });

      await runBefore(event);

      expect(event.headers.authorization).toBeUndefined();
    });
  });

  describe('the cookie caller on the same route', () => {
    function cookieCaller(role: OrgRole | undefined) {
      mockCookieBefore.mockImplementation((request: { event: APIGatewayProxyEventV2 }) => {
        (request.event as AuthenticatedEvent).requestContext.userInfo = buildEvent({
          userInfo: {
            userId: 'console-user',
            orgId: ORG_ID,
            membership: role ? membershipFor(ORG_ID, 'console-user', role) : NO_MEMBERSHIP,
          },
        }).requestContext.userInfo;
        return undefined;
      });
    }

    it('passes a role holding the declared cookie requirement', async () => {
      cookieCaller(OrgRole.ReadOnly);

      const { response } = await runBefore(bearerEvent());

      expect(response).toBeUndefined();
    });

    it('refuses a caller with no membership row', async () => {
      cookieCaller(undefined);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { response } = await runBefore(bearerEvent());

      expect(response?.statusCode).toBe(403);
      expect(JSON.parse(response?.body ?? '{}').code).toBe(ApiErrorCode.NOT_A_MEMBER);
    });

    it('returns the cookie middleware failure unchanged', async () => {
      const unauthorized = { statusCode: 401, body: '{}' };
      mockCookieBefore.mockResolvedValue(unauthorized);

      const { response } = await runBefore(bearerEvent());

      expect(response).toBe(unauthorized);
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
