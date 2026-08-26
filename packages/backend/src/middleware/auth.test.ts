import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ApiErrorCode, OrgRole, Stage } from '@filone/shared';
import { FINAL_SETUP_STATUS, OrgSetupStatus } from '../lib/org-setup-status.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOCK_USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MOCK_ORG_ID = '11111111-2222-3333-4444-555555555555';
const MOCK_SUB = 'auth0|abc123';
const MOCK_EMAIL = 'user@example.com';
const MOCK_PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocExample';
const MOCK_NAME = 'Test User';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let uuidCallCount = 0;
const MOCK_UUIDS = [MOCK_USER_ID, MOCK_ORG_ID];
vi.spyOn(crypto, 'randomUUID').mockImplementation(
  () => MOCK_UUIDS[uuidCallCount++] as `${string}-${string}-${string}-${string}-${string}`,
);

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockEnsureTrialEntitlement = vi.fn().mockResolvedValue(true);
vi.mock('../lib/trial-entitlement.js', () => ({
  ensureTrialEntitlement: (args: unknown) => mockEnsureTrialEntitlement(args),
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

/**
 * What `userInfo` carries when OrgTable holds no membership row: the transition
 * fallback resolves Owner, which is every pre-conversion account's authority.
 */
function ownerFallback(orgId: string, userId: string) {
  return { membership: { orgId, userId, role: OrgRole.Owner } };
}

/** What `userInfo` carries on the signup branch: the row just written, unread. */
function createdMembership(orgId: string, userId: string) {
  return {
    membership: {
      orgId,
      userId,
      role: OrgRole.Owner,
      joinedAt: expect.any(String),
      source: 'signup',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    // The real SDK always resolves an object; without this, a GetItem no test
    // stubbed (the org-profile fence read) resolves undefined and throws.
    ddbMock.on(GetItemCommand).resolves({});
    uuidCallCount = 0;
    // Every authenticated request reads the membership row. Default: no row,
    // which is what a pre-conversion account looks like; tests that care about
    // a role stub the read again with one.
    ddbMock.on(GetItemCommand, { TableName: 'OrgTable' }).resolves({});
  });

  describe('before hook', () => {
    it('returns 401 when no cookies are present', async () => {
      const { before } = authMiddleware();
      const request = buildMiddyRequest(buildEvent());

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    // The console is served from hostnames that authenticate against different
    // Auth0 domains. Tokens carry the issuing domain in `iss`, so validating with
    // the stage's configured domain would reject every session created on an
    // alias. Verification is rejected here on purpose — the assertion is about
    // which issuer and JWKS endpoint got used, which happens either way.
    describe('per-host Auth0 domain', () => {
      // The per-host table holds production domains only, so resolveAuth0Domain
      // consults it on the production stage alone.
      beforeEach(() => {
        process.env.FILONE_STAGE = Stage.Production;
      });

      afterEach(() => {
        delete process.env.FILONE_STAGE;
      });

      async function issuerUsedFor(host?: string): Promise<string> {
        mockJwtVerify.mockRejectedValue(new Error('token expired'));
        const event = buildEvent({ cookies: ['hs_access_token=some-token'] });
        if (host) event.headers['x-forwarded-host'] = host;

        const { before } = authMiddleware();
        await before(buildMiddyRequest(event));

        const opts = mockJwtVerify.mock.calls[0]?.[2] as { issuer: string };
        return opts.issuer;
      }

      it('validates against the custom domain on the canonical host', async () => {
        expect(await issuerUsedFor('app.fil.one')).toBe('https://auth.fil.one/');
      });

      it('validates against the tenant domain on a demo alias host', async () => {
        expect(await issuerUsedFor('app.filone.ai')).toBe('https://fil-one.us.auth0.com/');
        // First request for this domain, so its JWKS set is built here — which
        // only happens if the cache is keyed by domain rather than shared.
        expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
          new URL('https://fil-one.us.auth0.com/.well-known/jwks.json'),
        );
      });

      it('falls back to the configured domain when no viewer host is present', async () => {
        expect(await issuerUsedFor()).toBe(`https://${process.env.AUTH0_DOMAIN}/`);
      });

      // x-forwarded-host is attacker-controlled on the public execute-api path,
      // and the aliases only exist in production: a non-production deployment
      // handed a production host must stay on its own tenant.
      it('ignores a production host on a non-production stage', async () => {
        process.env.FILONE_STAGE = Stage.Staging;
        expect(await issuerUsedFor('app.fil.one')).toBe(`https://${process.env.AUTH0_DOMAIN}/`);
      });
    });

    it('resolves existing user and reads email from verified ID token', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      // First call: access token verify; second call: ID token verify
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
            email: { S: MOCK_EMAIL },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            pk: { S: `ORG#${existingOrgId}` },
            sk: { S: 'PROFILE' },
            name: { S: 'example.com' },
            auroraSetupStatus: { S: FINAL_SETUP_STATUS },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
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
      // ID token verified with client_id as audience
      expect(mockJwtVerify).toHaveBeenCalledTimes(2);
      expect(mockJwtVerify).toHaveBeenNthCalledWith(2, 'id-token', 'mock-jwks', {
        audience: 'test-client-id',
        issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      });
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
        emailVerified: false,
        name: undefined,
        picture: undefined,
        ...ownerFallback(existingOrgId, existingUserId),
      });
    });

    it('410s a tombstoned identity instead of resolving it', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            deletedAt: { S: '2026-08-12T00:00:00.000Z' },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: ['hs_access_token=valid-token', 'hs_id_token=id-token'],
      });

      const result = await before(buildMiddyRequest(event));

      expectErrorResponse(result, 410, {
        message: 'This account has been deleted.',
        code: ApiErrorCode.ACCOUNT_DELETED,
      });
      // Never re-created as a new signup.
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    });

    it('410s every member of a deleting org, on the profile fence alone', async () => {
      const existingOrgId = 'existing-org-uuid';

      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      // The identity row is untouched at confirm — only the profile is fenced.
      ddbMock
        .on(GetItemCommand, { Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } } })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: 'existing-user-uuid' },
            orgId: { S: existingOrgId },
          },
        });

      ddbMock
        .on(GetItemCommand, { Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } } })
        .resolves({
          Item: {
            pk: { S: `ORG#${existingOrgId}` },
            sk: { S: 'PROFILE' },
            deleting: { BOOL: true },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: ['hs_access_token=valid-token', 'hs_id_token=id-token'],
      });

      const result = await before(buildMiddyRequest(event));

      expectErrorResponse(result, 410, {
        message: 'This account has been deleted.',
        code: ApiErrorCode.ACCOUNT_DELETED,
      });
      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    });

    it('410s a tombstone rather than falling back to another token path', async () => {
      // No ID token cookie, so only the access token is verified. A refresh
      // token is present, and the tombstone must not be downgraded to a 401
      // that sends the request down the refresh path.
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } });

      ddbMock.on(GetItemCommand).resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          deletedAt: { S: '2026-08-12T00:00:00.000Z' },
        },
      });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: ['hs_access_token=valid-token', 'hs_refresh_token=refresh-token'],
      });

      const result = await before(buildMiddyRequest(event));

      expectErrorResponse(result, 410, {
        message: 'This account has been deleted.',
        code: ApiErrorCode.ACCOUNT_DELETED,
      });
    });

    it('resolves the role from the membership row', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: { userId: { S: existingUserId }, orgId: { S: existingOrgId } },
        });

      ddbMock
        .on(GetItemCommand, {
          TableName: 'OrgTable',
          Key: {
            pk: { S: `ORG#${existingOrgId}` },
            sk: { S: `MEMBER#${existingUserId}` },
          },
        })
        .resolves({
          Item: {
            role: { S: OrgRole.ReadOnly },
            joinedAt: { S: '2026-02-02T00:00:00.000Z' },
            source: { S: 'invitation' },
            invitedBy: { S: 'inviter-user-id' },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
      });

      await before(buildMiddyRequest(event));

      // The row's field mapping is org-membership.test.ts's subject; what this
      // one owns is that the middleware exposes the role the row carries.
      expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.ReadOnly);
    });

    describe('when the OrgTable membership read fails', () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      function stubIdentityAndFailingMembership() {
        ddbMock
          .on(GetItemCommand, {
            Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
          })
          .resolves({
            Item: { userId: { S: existingUserId }, orgId: { S: existingOrgId } },
          });
        ddbMock
          .on(GetItemCommand, { TableName: 'OrgTable' })
          .rejects(new Error('DynamoDB unavailable'));
      }

      it('answers a retryable 503 rather than spending a refresh on a good token', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockJwtVerify
          .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
          .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });
        stubIdentityAndFailingMembership();

        const { before } = authMiddleware({ requireVerifiedEmail: false });
        const request = buildMiddyRequest(
          buildEvent({
            cookies: [
              `hs_access_token=valid-token`,
              `hs_id_token=id-token`,
              `hs_refresh_token=valid-refresh`,
            ],
          }),
        );

        const result = (await before(request)) as APIGatewayProxyStructuredResultV2;

        expect(result.statusCode).toBe(503);
        // The token was fine — a refresh would have burned the caller's
        // refresh token to fix a failure that is ours.
        expect(mockFetch).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('OrgTable'),
          expect.objectContaining({ orgId: existingOrgId, userId: existingUserId }),
        );
        consoleError.mockRestore();
      });

      it('answers the same 503 on the refresh branch, carrying the rotated cookies', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockJwtVerify
          .mockRejectedValueOnce(new Error('token expired'))
          .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });
        mockDecodeJwt.mockReturnValue({ sub: MOCK_SUB });
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            id_token: 'new-id-token',
            refresh_token: 'new-refresh-token',
          }),
        });
        stubIdentityAndFailingMembership();

        const { before } = authMiddleware({ requireVerifiedEmail: false });
        const request = buildMiddyRequest(
          buildEvent({
            cookies: [`hs_access_token=expired-token`, `hs_refresh_token=valid-refresh`],
          }),
        );

        const result = (await before(request)) as APIGatewayProxyStructuredResultV2;

        expect(result.statusCode).toBe(503);
        // The refresh already happened: the old refresh token is spent, so the
        // denial has to hand back the new one or the caller is logged out.
        expect(result.cookies).toEqual(
          expect.arrayContaining([expect.stringContaining('hs_refresh_token=new-refresh-token')]),
        );
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
      });
    });

    it('extracts name and picture from ID token claims', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } }).mockResolvedValueOnce({
        payload: {
          email: MOCK_EMAIL,
          email_verified: true,
          name: MOCK_NAME,
          picture: MOCK_PICTURE,
        },
      });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
            email: { S: MOCK_EMAIL },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            pk: { S: `ORG#${existingOrgId}` },
            sk: { S: 'PROFILE' },
            name: { S: 'example.com' },
            auroraSetupStatus: { S: FINAL_SETUP_STATUS },
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
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
        emailVerified: true,
        name: MOCK_NAME,
        picture: MOCK_PICTURE,
        ...ownerFallback(existingOrgId, existingUserId),
      });
    });

    it('extracts picture from refreshed ID token', async () => {
      const existingUserId = 'refreshed-user-uuid';
      const existingOrgId = 'refreshed-org-uuid';

      mockJwtVerify.mockRejectedValueOnce(new Error('token expired')).mockResolvedValueOnce({
        payload: {
          email: MOCK_EMAIL,
          email_verified: true,
          name: MOCK_NAME,
          picture: MOCK_PICTURE,
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          refresh_token: 'new-refresh-token',
        }),
      });

      mockDecodeJwt.mockReturnValue({ sub: MOCK_SUB });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        });

      const { before } = authMiddleware();
      const event = buildEvent({
        cookies: [`hs_access_token=expired-token`, `hs_refresh_token=valid-refresh`],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
        emailVerified: true,
        name: MOCK_NAME,
        picture: MOCK_PICTURE,
        ...ownerFallback(existingOrgId, existingUserId),
      });
    });

    it('continues without email when ID token verification fails', async () => {
      const existingUserId = 'existing-user-uuid';
      const existingOrgId = 'existing-org-uuid';

      // Access token passes, ID token fails
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockRejectedValueOnce(new Error('id token expired'));

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
            email: { S: 'stored@example.com' },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=bad-id-token`],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      // ID token failed so email is null/undefined — email comes from claims only, not DB.
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
        email: undefined,
        emailVerified: false,
        name: undefined,
        picture: undefined,
        ...ownerFallback(existingOrgId, existingUserId),
      });
    });

    it('email is undefined when no ID token cookie is present', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: 'should-be-ignored@example.com' },
      });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`],
        rawPath: '/api/me',
      });
      const request = buildMiddyRequest(event);

      await before(request);

      // Only one jwtVerify call (access token), no second call for ID token
      expect(mockJwtVerify).toHaveBeenCalledTimes(1);
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
        email: undefined,
        emailVerified: false,
        name: undefined,
        picture: undefined,
        ...createdMembership(MOCK_ORG_ID, MOCK_USER_ID),
      });
    });

    it('creates new user and org with auto-confirmed name and triggers setup + billing trial', async () => {
      // First call: access token verify; second call: ID token verify
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, name: 'Alice Johnson' } });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        rawPath: '/api/me',
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
        email: MOCK_EMAIL,
        emailVerified: false,
        name: 'Alice Johnson',
        picture: undefined,
        ...createdMembership(MOCK_ORG_ID, MOCK_USER_ID),
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
              createdAt: { S: expect.any(String) },
              // The address is unverified here, so only the name is stamped.
              profileName: { S: 'Alice Johnson' },
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
              createdAt: { S: expect.any(String) },
              name: { S: 'Alice Johnson' },
            },
          },
        },
        // Org profile — derived from JWT name claim
        {
          Put: {
            TableName: 'UserInfoTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: 'PROFILE' },
              name: { S: 'Alice Org' },
              auroraSetupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
              createdBy: { S: MOCK_USER_ID },
              createdAt: { S: expect.any(String) },
            },
          },
        },
        // Owner count — in OrgTable, beside the membership rows it counts
        {
          Put: {
            TableName: 'OrgTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: 'META' },
              ownerCount: { N: '1' },
            },
          },
        },
        // Org membership — authoritative, in OrgTable, and the creator owns it
        {
          Put: {
            TableName: 'OrgTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: `MEMBER#${MOCK_USER_ID}` },
              role: { S: OrgRole.Owner },
              joinedAt: { S: expect.any(String) },
              source: { S: 'signup' },
            },
          },
        },
        // Inverse item — same transaction, so the two can never disagree
        {
          Put: {
            TableName: 'OrgTable',
            Item: {
              pk: { S: `USER#${MOCK_USER_ID}` },
              sk: { S: `MEMBERSHIP#${MOCK_ORG_ID}` },
              role: { S: OrgRole.Owner },
              joinedAt: { S: expect.any(String) },
            },
          },
        },
      ]);

      // Entitlement claim + trial are delegated to ensureTrialEntitlement
      // (verified-email gated). Unit-tested separately in trial-entitlement.test.ts.
      expect(mockEnsureTrialEntitlement).toHaveBeenCalledWith({
        sub: MOCK_SUB,
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
        email: MOCK_EMAIL,
        emailVerified: false,
      });
    });

    it('does not block login when the trial entitlement backfill fails transiently', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, name: 'Alice Johnson' } });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});
      // Entitlement backfill throws (e.g. Stripe/DynamoDB down) — login must still succeed.
      mockEnsureTrialEntitlement.mockRejectedValueOnce(new Error('Stripe down'));

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        rawPath: '/api/me',
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toMatchObject({
        sub: MOCK_SUB,
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
      });
      expect(mockEnsureTrialEntitlement).toHaveBeenCalledOnce();
    });

    it('falls back to email-derived org name when no JWT name claim is present', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        rawPath: '/api/me',
      });
      const request = buildMiddyRequest(event);

      await before(request);

      const transactCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
      const orgItem = transactCalls[0].args[0].input.TransactItems?.[2].Put?.Item;
      expect(orgItem?.name).toEqual({ S: 'Example' });
      expect(orgItem?.orgConfirmed).toBeUndefined();
    });

    it('refreshes tokens when access token is expired but refresh token is valid', async () => {
      const existingUserId = 'refreshed-user-uuid';
      const existingOrgId = 'refreshed-org-uuid';

      // First call: access token verify fails; second call: refreshed ID token verify succeeds
      mockJwtVerify
        .mockRejectedValueOnce(new Error('token expired'))
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL } });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          refresh_token: 'new-refresh-token',
        }),
      });

      // decodeJwt is used for the refreshed access token (sub extraction)
      mockDecodeJwt.mockReturnValue({
        sub: MOCK_SUB,
      });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=expired-token`, `hs_refresh_token=valid-refresh`],
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toStrictEqual({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
        email: MOCK_EMAIL,
        emailVerified: false,
        name: undefined,
        picture: undefined,
        ...ownerFallback(existingOrgId, existingUserId),
      });
      expect(request.internal.newTokens).toEqual({
        access_token: 'new-access-token',
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
      });
    });

    it('forceRefresh=1 falls back to existing access token when refresh exchange fails', async () => {
      const existingUserId = 'fallback-user-uuid';
      const existingOrgId = 'fallback-org-uuid';

      // Access token verify succeeds (used in fallback path); no ID token cookie so
      // extractIdTokenClaims returns early without calling jwtVerify
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } });

      // Refresh exchange fails
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#${existingOrgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_refresh_token=bad-refresh`],
        queryStringParameters: { forceRefresh: '1' },
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toMatchObject({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
      });
    });

    it('forceRefresh=1 falls back to existing access token when no refresh token present', async () => {
      const existingUserId = 'fallback-user-uuid';
      const existingOrgId = 'fallback-org-uuid';

      // Access token verify succeeds (fallback); no ID token so extractIdTokenClaims returns defaults
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } });
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => '' });

      // Use call-order mocking: first GetItem is the IDENTITY lookup, second the
      // ORG PROFILE lookup. Everything after — the membership read the
      // middleware now makes — falls to the empty default.
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({ Item: { userId: { S: existingUserId }, orgId: { S: existingOrgId } } })
        .resolvesOnce({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        })
        .resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`],
        queryStringParameters: { forceRefresh: '1' },
      });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toMatchObject({
        sub: MOCK_SUB,
        userId: existingUserId,
        orgId: existingOrgId,
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
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=expired`, `hs_refresh_token=bad-refresh`],
        }),
      );

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    it('returns 401 when access token expired and refresh fetch throws', async () => {
      mockJwtVerify.mockRejectedValue(new Error('token expired'));
      mockFetch.mockRejectedValue(new Error('network error'));

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=expired`, `hs_refresh_token=some-refresh`],
        }),
      );

      const result = await before(request);

      expectErrorResponse(result, 401, { message: 'Unauthorized' });
    });

    it('parses cookies from event.cookies array correctly', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
      });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            pk: { S: `SUB#${MOCK_SUB}` },
            sk: { S: 'IDENTITY' },
            userId: { S: 'some-user' },
            orgId: { S: 'some-org' },
          },
        });

      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `ORG#some-org` }, sk: { S: 'PROFILE' } },
        })
        .resolves({
          Item: {
            auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          },
        });

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [' hs_access_token = my-token '],
        }),
      );

      await before(request);

      expect(mockJwtVerify).toHaveBeenCalledWith('my-token', 'mock-jwks', {
        audience: process.env.AUTH0_AUDIENCE,
        issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      });
    });
  });

  describe('verified email gate', () => {
    const existingUserId = 'gate-user-uuid';
    const existingOrgId = 'gate-org-uuid';

    function mockExistingUser() {
      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
          },
        });
    }

    it('returns 403 EMAIL_NOT_VERIFIED by default when email is unverified', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });
      mockExistingUser();

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );

      const result = await before(request);

      expectErrorResponse(result, 403, {
        message: 'Email verification required',
        code: ApiErrorCode.EMAIL_NOT_VERIFIED,
      });
    });

    it('allows the request by default when email is verified', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });
      mockExistingUser();

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );

      const result = await before(request);

      expect(result).toBeUndefined();
    });

    it('returns 403 on the refresh path when refreshed claims are unverified', async () => {
      mockJwtVerify
        .mockRejectedValueOnce(new Error('token expired'))
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          refresh_token: 'new-refresh-token',
        }),
      });
      mockDecodeJwt.mockReturnValue({ sub: MOCK_SUB });
      mockExistingUser();

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=expired-token`, `hs_refresh_token=valid-refresh`],
        }),
      );

      const result = (await before(request)) as APIGatewayProxyStructuredResultV2;

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body as string)).toStrictEqual({
        message: 'Email verification required',
        code: ApiErrorCode.EMAIL_NOT_VERIFIED,
      });
      // The refresh already spent the caller's refresh token, so the denial
      // carries its replacement — otherwise a 403 becomes a logout.
      expect(result.cookies).toEqual(
        expect.arrayContaining([expect.stringContaining('hs_refresh_token=new-refresh-token')]),
      );
    });

    it('fails closed when the ID token cookie is missing entirely', async () => {
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } });
      mockExistingUser();

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`],
        }),
      );

      const result = await before(request);

      expectErrorResponse(result, 403, {
        message: 'Email verification required',
        code: ApiErrorCode.EMAIL_NOT_VERIFIED,
      });
    });

    it('allows unverified email when requireVerifiedEmail is false', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });
      mockExistingUser();

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );

      const result = await before(request);

      expect(result).toBeUndefined();
    });

    it('still creates a new user and org before blocking on unverified email', async () => {
      // Identity creation is authentication-time work; the gate is an
      // authorization check that runs after it. A brand-new (unverified)
      // user must still get their user/org records so /me works.
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware();
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );

      const result = await before(request);

      expectErrorResponse(result, 403, {
        message: 'Email verification required',
        code: ApiErrorCode.EMAIL_NOT_VERIFIED,
      });
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
    });
  });

  describe('verified email on the user profile', () => {
    const existingUserId = 'stamp-user-uuid';
    const existingOrgId = 'stamp-org-uuid';

    function mockExistingUser(identity: Record<string, unknown> = {}) {
      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
            emailEntitlementClaimed: { BOOL: true },
            ...identity,
          },
        });
      ddbMock.on(UpdateItemCommand).resolves({});
    }

    function verifiedLogin() {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });
      return buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );
    }

    it('stamps the verified email at signup', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: true } });
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware();
      await before(
        buildMiddyRequest(
          buildEvent({
            cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
          }),
        ),
      );

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(items?.[0].Put?.Item?.profileEmail).toStrictEqual({ S: MOCK_EMAIL });
      expect(items?.[1].Put?.Item?.email).toStrictEqual({ S: MOCK_EMAIL });
      // The stamp rides the account transaction, so it costs no extra write.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('leaves the address off an unverified signup', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      await before(
        buildMiddyRequest(
          buildEvent({
            cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
          }),
        ),
      );

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(items?.[0].Put?.Item?.profileEmail).toBeUndefined();
      expect(items?.[1].Put?.Item?.email).toBeUndefined();
    });

    it('backfills a profile that was created before the address was stamped', async () => {
      mockExistingUser();

      const { before } = authMiddleware();
      const result = await before(verifiedLogin());

      expect(result).toBeUndefined();
      const updates = ddbMock.commandCalls(UpdateItemCommand);
      expect(updates).toHaveLength(2);
      // Profile first: a marker ahead of the row it claims would stop the repair.
      expect(updates[0].args[0].input.Key).toStrictEqual({
        pk: { S: `USER#${existingUserId}` },
        sk: { S: 'PROFILE' },
      });
      expect(updates[0].args[0].input.ExpressionAttributeValues).toStrictEqual({
        ':email': { S: MOCK_EMAIL },
      });
      expect(updates[1].args[0].input.Key).toStrictEqual({
        pk: { S: `SUB#${MOCK_SUB}` },
        sk: { S: 'IDENTITY' },
      });
    });

    it('writes nothing when the profile already holds the current address', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL } });

      const { before } = authMiddleware();
      await before(verifiedLogin());

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('re-stamps after the address changes', async () => {
      mockExistingUser({ profileEmail: { S: 'old@example.com' } });

      const { before } = authMiddleware();
      await before(verifiedLogin());

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
    });

    it('does not stamp an unverified address on an existing account', async () => {
      mockExistingUser();
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, email_verified: false } });

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      await before(
        buildMiddyRequest(
          buildEvent({
            cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
          }),
        ),
      );

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('does not block the request when the stamp fails', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockExistingUser();
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB unavailable'));

      const { before } = authMiddleware();
      const result = await before(verifiedLogin());

      expect(result).toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('display name on the user profile', () => {
    const existingUserId = 'name-stamp-user-uuid';
    const existingOrgId = 'name-stamp-org-uuid';

    function mockExistingUser(identity: Record<string, unknown> = {}) {
      ddbMock
        .on(GetItemCommand, {
          Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
        })
        .resolves({
          Item: {
            userId: { S: existingUserId },
            orgId: { S: existingOrgId },
            emailEntitlementClaimed: { BOOL: true },
            ...identity,
          },
        });
      ddbMock.on(UpdateItemCommand).resolves({});
    }

    function login(idClaims: Record<string, unknown>) {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: idClaims });
      return buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        }),
      );
    }

    it('stamps the name on a profile whose marker is absent', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL } });

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: MOCK_NAME }));

      const updates = ddbMock.commandCalls(UpdateItemCommand);
      expect(updates).toHaveLength(2);
      expect(updates[0].args[0].input.Key).toStrictEqual({
        pk: { S: `USER#${existingUserId}` },
        sk: { S: 'PROFILE' },
      });
      expect(updates[0].args[0].input.ExpressionAttributeValues).toStrictEqual({
        ':name': { S: MOCK_NAME },
      });
      expect(updates[1].args[0].input.Key).toStrictEqual({
        pk: { S: `SUB#${MOCK_SUB}` },
        sk: { S: 'IDENTITY' },
      });
      expect(updates[1].args[0].input.UpdateExpression).toContain('profileName');
    });

    it('re-stamps after the name changes', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL }, profileName: { S: 'Old Name' } });

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: MOCK_NAME }));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
    });

    it('writes nothing when the profile already holds both the address and the name', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL }, profileName: { S: MOCK_NAME } });

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: MOCK_NAME }));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('writes the address and the name in one update when both are stale', async () => {
      mockExistingUser();

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: MOCK_NAME }));

      const updates = ddbMock.commandCalls(UpdateItemCommand);
      expect(updates).toHaveLength(2);
      expect(updates[0].args[0].input.ExpressionAttributeValues).toStrictEqual({
        ':email': { S: MOCK_EMAIL },
        ':name': { S: MOCK_NAME },
      });
      expect(updates[1].args[0].input.ExpressionAttributeValues).toStrictEqual({
        ':email': { S: MOCK_EMAIL },
        ':name': { S: MOCK_NAME },
      });
    });

    it('stamps the name even when the address is unverified', async () => {
      mockExistingUser();

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      await before(login({ email: MOCK_EMAIL, email_verified: false, name: MOCK_NAME }));

      const updates = ddbMock.commandCalls(UpdateItemCommand);
      expect(updates).toHaveLength(2);
      expect(updates[0].args[0].input.ExpressionAttributeValues).toStrictEqual({
        ':name': { S: MOCK_NAME },
      });
      expect(updates[1].args[0].input.UpdateExpression).not.toContain('profileEmail');
    });

    it('leaves a stamped name alone when the token carries none', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL }, profileName: { S: MOCK_NAME } });

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true }));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('does not stamp an empty name', async () => {
      mockExistingUser({ profileEmail: { S: MOCK_EMAIL } });

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: '' }));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('stamps the name at signup', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true, name: MOCK_NAME }));

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(items?.[0].Put?.Item?.profileName).toStrictEqual({ S: MOCK_NAME });
      expect(items?.[1].Put?.Item?.name).toStrictEqual({ S: MOCK_NAME });
      // The stamp rides the account transaction, so it costs no extra write.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('stamps the name at signup even when the address is unverified', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      await before(login({ email: MOCK_EMAIL, email_verified: false, name: MOCK_NAME }));

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(items?.[0].Put?.Item?.profileName).toStrictEqual({ S: MOCK_NAME });
      expect(items?.[1].Put?.Item?.name).toStrictEqual({ S: MOCK_NAME });
      expect(items?.[0].Put?.Item?.profileEmail).toBeUndefined();
      expect(items?.[1].Put?.Item?.email).toBeUndefined();
    });

    it('leaves the name off a signup whose token carries none', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware();
      await before(login({ email: MOCK_EMAIL, email_verified: true }));

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(items?.[0].Put?.Item?.profileName).toBeUndefined();
      expect(items?.[1].Put?.Item?.name).toBeUndefined();
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
      expect(cookies[0]).toBe(
        'hs_access_token=new-at; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600',
      );
      expect(cookies[1]).toBe(
        'hs_id_token=new-it; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600',
      );
      expect(cookies[2]).toBe(
        'hs_refresh_token=new-rt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
      );
      expect(cookies[3]).toBe('hs_logged_in=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[4]).toMatch(
        /^hs_csrf_token=[a-f0-9-]+; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/,
      );
    });

    it('always refreshes when _forceTokenRefresh is set, even when before-hook already set newTokens', async () => {
      const { after } = authMiddleware();
      const response: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: '{}' };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'post-handler-at',
          id_token: 'post-handler-it',
          refresh_token: 'post-handler-rt',
        }),
      });
      mockDecodeJwt.mockReturnValue({ sub: MOCK_SUB });

      const event = buildEvent();
      (
        event.requestContext as APIGatewayProxyEventV2['requestContext'] & {
          _forceTokenRefresh?: boolean;
        }
      )._forceTokenRefresh = true;

      const request: AuthRequest = {
        event,
        context: {} as Context,
        response,
        error: undefined,
        internal: {
          // Before-hook already produced tokens (e.g. access token was expired and refreshed)
          newTokens: {
            access_token: 'before-hook-at',
            id_token: 'before-hook-it',
            refresh_token: 'before-hook-rt',
          },
          refreshToken: 'before-hook-rt',
        },
      };

      await after(request);

      // Cookies should reflect the post-handler refresh, not the before-hook tokens
      const cookies = response.cookies ?? [];
      expect(cookies[0]).toContain('post-handler-at');
      expect(cookies[1]).toContain('post-handler-it');
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
