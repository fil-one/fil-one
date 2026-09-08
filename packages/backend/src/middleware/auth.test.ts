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
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ApiErrorCode, OrgRole, Stage } from '@filone/shared';
import { FINAL_SETUP_STATUS, OrgSetupStatus } from '../lib/org-setup-status.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';
import { auditItemIn, hasAuditItem } from '../test/audit-assertions.js';

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
const realRandomUUID = crypto.randomUUID.bind(crypto);
// The seeded pair is the user id and the org id, in the order signup mints
// them. Every id after those — the audit event's, and the CSRF token's — stays
// random, so a test that pins the first two does not silently hand a later
// caller `undefined`.
vi.spyOn(crypto, 'randomUUID').mockImplementation(
  () =>
    (MOCK_UUIDS[uuidCallCount++] ??
      realRandomUUID()) as `${string}-${string}-${string}-${string}-${string}`,
);

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

// The subscription guard is the system's only entitlement claim point: it runs
// on the first gated request, in the caller's own org, which is the one place
// that can tell that org from somebody else's (ADR §4/§5). This mock stands so
// a claim on the login path is caught here instead of reaching Stripe — the
// tests below require it to stay unused.
const mockEnsureTrialEntitlement = vi.fn();
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
import { authorize } from './authorize.js';

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
 * What `userInfo` carries when OrgTable holds no membership row: nothing. The
 * conversion has backfilled every account, so absence means the caller is not a
 * member — `authorize` refuses the request, and the middleware's job is to
 * report the absence honestly rather than default it away.
 */
function noMembership() {
  return { membership: undefined };
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
    // which the middleware reports as absent and `authorize` refuses; tests
    // that care about a role stub the read again with one.
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
        ...noMembership(),
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

    it('leaves an absent membership row absent, defaulting nothing', async () => {
      // The conversion has run: an account with no row is not a member, and
      // resolving one as Owner here would hand the whole org to whoever the
      // conversion missed. `authorize` turns the absence into a 403.
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

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
      });

      // Authentication still succeeds — /api/me carries no role gate and must
      // answer, so the console can say what happened.
      expect(await before(buildMiddyRequest(event))).toBeUndefined();
      expect(getUserInfoFromEvent(event).membership).toBeUndefined();
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
        ...noMembership(),
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
        ...noMembership(),
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
        ...noMembership(),
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

    it('creates new user and org with a derived name, deferring tenant setup and claiming nothing', async () => {
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
      const items = transactCalls[0].args[0].input.TransactItems!;
      // Slugs are random, not derived from the org name — read back whatever
      // `reserveOrgSlug` picked, then assert every row agrees on it.
      const slug = items[2]!.Put!.Item!.slug!.S;
      expect(items).toStrictEqual([
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
              slug: { S: slug },
              nameConfirmed: { BOOL: false },
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
        // The org's slug reservation — the claim row `reserveOrgSlug` plans,
        // landing in the same transaction as the rows it names.
        {
          Put: {
            TableName: 'OrgTable',
            Item: {
              pk: { S: `SLUG#${slug}` },
              sk: { S: 'LOOKUP' },
              orgId: { S: MOCK_ORG_ID },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        // The org.created event, the last item and the one after the seven rows
        // an account is: an org cannot come into existence unrecorded, because
        // the rows that create it and the row that records it are the same
        // transaction.
        {
          Put: {
            TableName: 'AuditTable',
            Item: {
              pk: { S: `ORG#${MOCK_ORG_ID}` },
              sk: { S: expect.any(String) },
              // The event-type index, stamped on every write so the viewer's
              // type filter can never miss an event that was already stored.
              gsi1pk: { S: `ORG#${MOCK_ORG_ID}#TYPE#org.created` },
              gsi1sk: { S: expect.any(String) },
              eventId: { S: expect.any(String) },
              type: { S: 'org.created' },
              // No email: this ID token carries no `email_verified` claim, and
              // an unverified address must never be the name the audit viewer
              // shows as the member's identity.
              actor: { M: { kind: { S: 'user' }, id: { S: MOCK_USER_ID } } },
              orgId: { S: MOCK_ORG_ID },
              subject: { S: `org:${MOCK_ORG_ID}` },
              details: { M: { orgName: { S: 'Alice Org' }, source: { S: 'signup' } } },
              createdAt: { S: expect.any(String) },
              ttl: { N: expect.any(String) },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ]);

      // Signup mints the account and stops there. Claiming here would spend an
      // invitee's entitlement the moment they signed in — the thing the guard's
      // conditions exist to prevent; an organic signup claims one request later,
      // on the dashboard's first API call.
      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    });

    it('names the actor by their email once the claim says it is verified', async () => {
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } }).mockResolvedValueOnce({
        payload: { email: MOCK_EMAIL, email_verified: true, name: 'Alice Johnson' },
      });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteItemsCommand).resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const request = buildMiddyRequest(
        buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
          rawPath: '/api/me',
        }),
      );

      await before(request);

      const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems;
      expect(auditItemIn(items).actor).toStrictEqual({
        M: { kind: { S: 'user' }, id: { S: MOCK_USER_ID }, email: { S: MOCK_EMAIL } },
      });
    });

    it('creates the account anyway when the audit item is the half the table refused', async () => {
      mockJwtVerify
        .mockResolvedValueOnce({ payload: { sub: MOCK_SUB } })
        .mockResolvedValueOnce({ payload: { email: MOCK_EMAIL, name: 'Alice Johnson' } });

      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejectsOnce(
          new TransactionCanceledException({
            message: 'cancelled',
            $metadata: {},
            CancellationReasons: [
              ...Array.from({ length: 7 }, () => ({ Code: 'None' })),
              { Code: 'TransactionConflict' },
            ],
          }),
        )
        .resolves({});

      const { before } = authMiddleware({ requireVerifiedEmail: false });
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        rawPath: '/api/me',
      });

      // This runs inside the auth middleware: a cancelled signup would answer
      // every new customer's first login with a 401 and send them round the
      // auth loop. An unrecorded org is recoverable; an account nobody can
      // create is not.
      const result = await before(buildMiddyRequest(event));

      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event)).toMatchObject({ userId: MOCK_USER_ID });
      const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
      expect(calls).toHaveLength(2);
      expect(hasAuditItem(calls[1].args[0].input.TransactItems)).toBe(false);
      expect(calls[1].args[0].input.TransactItems).toHaveLength(7);
    });

    it('signs an existing user in without claiming an entitlement', async () => {
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
        userId: existingUserId,
        orgId: existingOrgId,
      });
      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
      // Every account a user belongs to reaches the guard on its own first
      // gated request, so the login path owes none of them a Stripe call.
      expect(mockFetch).not.toHaveBeenCalled();
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
        ...noMembership(),
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
      // membership read. Everything after — the org profile the
      // identity-provider rule reads — falls to the empty default.
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

  describe('the active org header', () => {
    const PERSONAL_ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
    const OTHER_ORG = 'aaaaaaaa-0000-0000-0000-000000000002';
    const USER_ID = 'aaaaaaaa-0000-0000-0000-00000000000a';

    /**
     * `idTokenClaims` lands in the ID token's verified payload, so a test naming
     * `org_id` there drives the real claim through `extractIdTokenClaims` into
     * the identity-provider rule — renaming the claim breaks the test.
     */
    function signInAs(orgId: string, idTokenClaims: Record<string, unknown> = {}) {
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: MOCK_SUB } }).mockResolvedValueOnce({
        payload: { email: MOCK_EMAIL, email_verified: true, ...idTokenClaims },
      });
      ddbMock
        .on(GetItemCommand, { Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } } })
        .resolves({ Item: { userId: { S: USER_ID }, orgId: { S: orgId } } });
      // No `auth0OrgId` on either org — the M1 state, in which the rule admits
      // every session.
      for (const profiled of [PERSONAL_ORG, OTHER_ORG]) {
        ddbMock
          .on(GetItemCommand, {
            TableName: 'UserInfoTable',
            Key: { pk: { S: `ORG#${profiled}` }, sk: { S: 'PROFILE' } },
          })
          .resolves({ Item: { name: { S: 'Acme' } } });
      }
    }

    function stubMemberOf(orgId: string, role: OrgRole) {
      ddbMock
        .on(GetItemCommand, {
          TableName: 'OrgTable',
          Key: { pk: { S: `ORG#${orgId}` }, sk: { S: `MEMBER#${USER_ID}` } },
        })
        .resolves({ Item: { role: { S: role }, joinedAt: { S: '2026-01-01T00:00:00.000Z' } } });
    }

    function requestNaming(orgId: string) {
      const event = buildEvent({
        cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
      });
      event.headers['x-org-id'] = orgId;
      return { event, request: buildMiddyRequest(event) };
    }

    it('resolves the role in the org the header names', async () => {
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      stubMemberOf(OTHER_ORG, OrgRole.ReadOnly);
      const { event, request } = requestNaming(OTHER_ORG);

      const result = await authMiddleware().before(request);

      expect(result).toBeUndefined();
      // Both halves matter: the org every downstream key expression is built
      // from, and the role that org's own row carries.
      expect(getUserInfoFromEvent(event).orgId).toBe(OTHER_ORG);
      expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.ReadOnly);
    });

    it('refuses a header that is not an organization id', async () => {
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      const { event, request } = requestNaming(`ORG#${OTHER_ORG}`);

      const result = (await authMiddleware().before(request)) as APIGatewayProxyStructuredResultV2;

      expect(result.statusCode).toBe(400);
      expect(getUserInfoFromEvent(event).orgId).toBe(PERSONAL_ORG);
    });

    it('leaves the membership absent when the caller is not in the named org', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      // No row in the named org, and the default stub answers absence.
      const { event, request } = requestNaming(OTHER_ORG);

      expect(await authMiddleware().before(request)).toBeUndefined();
      expect(getUserInfoFromEvent(event).membership).toBeUndefined();

      // Which is the 403 every authenticated route already produces: the header
      // adds no authority, so naming an org the caller has left is refused by
      // the same gate that refuses a revoked membership in their own org.
      const denied = authorize('buckets.read').before(
        buildMiddyRequest(event),
      ) as APIGatewayProxyStructuredResultV2;
      expectErrorResponse(denied, 403, {
        message: 'You are not a member of this organization.',
        code: ApiErrorCode.NOT_A_MEMBER,
      });
      errorSpy.mockRestore();
    });

    it('serves /me from the caller’s own org when the named one has no row', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      const { event, request } = requestNaming(OTHER_ORG);

      const result = await authMiddleware({ orgHeaderFallback: true }).before(request);

      expect(result).toBeUndefined();
      // The response then echoes an org id that disagrees with the console's
      // stash, which is what tells the console to clear it.
      expect(getUserInfoFromEvent(event).orgId).toBe(PERSONAL_ORG);
      expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.Owner);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not fall back for a caller who is a member of the named org', async () => {
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      stubMemberOf(OTHER_ORG, OrgRole.Admin);
      const { event, request } = requestNaming(OTHER_ORG);

      await authMiddleware({ orgHeaderFallback: true }).before(request);

      expect(getUserInfoFromEvent(event).orgId).toBe(OTHER_ORG);
      expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.Admin);
    });

    it('serves /me from the caller’s own org when the header is not an org id', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      signInAs(PERSONAL_ORG);
      stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
      const { event, request } = requestNaming('not-a-uuid');

      const result = await authMiddleware({ orgHeaderFallback: true }).before(request);

      // The 400 every other route answers would leave the console holding an
      // unreadable stash and no endpoint willing to say so.
      expect(result).toBeUndefined();
      expect(getUserInfoFromEvent(event).orgId).toBe(PERSONAL_ORG);
      warnSpy.mockRestore();
    });

    describe('the identity-provider rule', () => {
      function stubRestrictedProfile(orgId: string, auth0OrgId: string) {
        ddbMock
          .on(GetItemCommand, {
            TableName: 'UserInfoTable',
            Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
          })
          .resolves({ Item: { name: { S: 'Acme' }, auth0OrgId: { S: auth0OrgId } } });
      }

      function requestWithNoHeader() {
        const event = buildEvent({
          cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
        });
        return { event, request: buildMiddyRequest(event) };
      }

      function profileReadsOf(orgId: string) {
        return ddbMock
          .commandCalls(GetItemCommand)
          .map((call) => call.args[0].input)
          .filter(
            (input) => input.TableName === 'UserInfoTable' && input.Key?.pk?.S === `ORG#${orgId}`,
          );
      }

      it('refuses a session that did not authenticate at the org, header or not', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        signInAs(PERSONAL_ORG);
        stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
        stubRestrictedProfile(PERSONAL_ORG, 'org_auth0_acme');
        const { event, request } = requestWithNoHeader();

        const result = (await authMiddleware().before(
          request,
        )) as APIGatewayProxyStructuredResultV2;

        // Sending no header would otherwise skip the one rule that keeps a
        // plain Universal Login session out of an org that demands its own
        // provider — including the caller's own.
        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body!).message).toContain('identity provider');
        expect(getUserInfoFromEvent(event).orgId).toBe(PERSONAL_ORG);
        warnSpy.mockRestore();
      });

      it('admits the session whose ID token carries the org’s org_id claim', async () => {
        signInAs(PERSONAL_ORG, { org_id: 'org_auth0_acme' });
        stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
        stubRestrictedProfile(PERSONAL_ORG, 'org_auth0_acme');
        const { event, request } = requestWithNoHeader();

        expect(await authMiddleware().before(request)).toBeUndefined();
        expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.Owner);
      });

      it('reads no profile for a caller who is not a member of the org they named', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        signInAs(PERSONAL_ORG);
        stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
        stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');
        const { event, request } = requestNaming(OTHER_ORG);

        expect(await authMiddleware().before(request)).toBeUndefined();

        // Whether an org authenticates through its own provider is not
        // something a non-member gets to learn by naming its id: they meet the
        // same NOT_A_MEMBER 403 either way.
        expect(profileReadsOf(OTHER_ORG)).toHaveLength(0);
        const denied = authorize('buckets.read').before(
          buildMiddyRequest(event),
        ) as APIGatewayProxyStructuredResultV2;
        expectErrorResponse(denied, 403, {
          message: 'You are not a member of this organization.',
          code: ApiErrorCode.NOT_A_MEMBER,
        });
        errorSpy.mockRestore();
      });

      it('serves /me from the caller’s own org when the named one refuses the session', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        signInAs(PERSONAL_ORG);
        stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
        stubMemberOf(OTHER_ORG, OrgRole.Admin);
        stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');
        const { event, request } = requestNaming(OTHER_ORG);

        const result = await authMiddleware({ orgHeaderFallback: true }).before(request);

        expect(result).toBeUndefined();
        expect(getUserInfoFromEvent(event).orgId).toBe(PERSONAL_ORG);
        expect(getUserInfoFromEvent(event).membership?.role).toBe(OrgRole.Owner);
        warnSpy.mockRestore();
      });

      it('refuses /me too when the caller’s own org refuses the session', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        signInAs(PERSONAL_ORG);
        stubMemberOf(PERSONAL_ORG, OrgRole.Owner);
        stubRestrictedProfile(PERSONAL_ORG, 'org_auth0_acme');
        const { request } = requestWithNoHeader();

        const result = (await authMiddleware({
          orgHeaderFallback: true,
        }).before(request)) as APIGatewayProxyStructuredResultV2;

        // There is nowhere left to fall back to, and the way in is to
        // authenticate through the org's own provider.
        expect(result.statusCode).toBe(403);
        warnSpy.mockRestore();
      });
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
