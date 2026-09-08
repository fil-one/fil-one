// Every other get-billing test (`get-billing.test.ts`) calls `baseHandler`
// directly with a hand-built `userInfo` that already carries a membership
// object — real for the read-model logic those tests are about, but it means
// no test in this codebase ever exercises `claimTrialIfEligible`'s eligibility
// check (`isSoloPersonalOrg`) against a `userInfo.membership` the real
// `authMiddleware` chain actually resolved from DynamoDB, the way a genuine
// first `GET /api/billing` after signup would populate it.
//
// This file closes that gap: the real exported `handler` (auth middleware,
// authorize, and all), a caller whose membership row `attachMembership` has to
// read for itself rather than being handed one, and only `ensureTrialEntitlement`
// — the one place Stripe gets called — replaced with a spy. Everything between
// the cookie and that call is the genuine code path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubMembershipRead,
  stubMembershipList,
} from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () =>
  sstResourceMock({
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  }),
);

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

// The one Stripe-touching boundary this test replaces. Everything upstream of
// it — membership resolution, `isSoloPersonalOrg`, the legacy-row guard — runs
// for real, against the DynamoDB rows stubbed below.
const mockEnsureTrialEntitlement = vi.fn();
vi.mock('../lib/trial-entitlement.js', () => ({
  ensureTrialEntitlement: (...args: unknown[]) => mockEnsureTrialEntitlement(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './get-billing.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';

function billingEvent() {
  return buildEvent({
    cookies: [`hs_access_token=valid-token`, `hs_id_token=id-token`],
    userInfo: {
      userId: MOCK_USER_ID,
      orgId: MOCK_ORG_ID,
      email: MOCK_EMAIL,
      // Nothing stamped here: the real chain runs and reads the caller's own
      // membership off the row, the same way `update-org.test.ts` does.
      membership: NO_MEMBERSHIP,
    },
    method: 'GET',
    rawPath: '/api/billing',
  });
}

describe('GET /api/billing — real membership resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

    // The account already exists — this is the request after signup, not
    // signup itself.
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
          emailEntitlementClaimed: { BOOL: false },
          profileEmail: { S: MOCK_EMAIL },
        },
      });

    // The active org's own profile — read by `enforceIdentityProvider` (no
    // `auth0OrgId`, so no SSO restriction applies) and by `isOrgDeleting`
    // (absent `deleting`, so the org is live).
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Acme' } } });

    // No subscription row yet, on either key — this is a brand-new org.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});

    // The caller's own membership: Owner, from signup — `attachMembership`
    // reads this for itself, rather than being handed it.
    stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID, role: OrgRole.Owner });
    // Exactly one org — the condition `isSoloPersonalOrg` requires.
    stubMembershipList(ddbMock, {
      userId: MOCK_USER_ID,
      orgs: [{ orgId: MOCK_ORG_ID, role: OrgRole.Owner }],
    });

    mockEnsureTrialEntitlement.mockResolvedValue(true);
  });

  it('claims the trial through the real membership-resolution path', async () => {
    const result = await handler(billingEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockEnsureTrialEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER_ID,
        orgId: MOCK_ORG_ID,
        email: MOCK_EMAIL,
        emailVerified: true,
      }),
    );
  });

  it('never claims for a member of more than one org', async () => {
    stubMembershipList(ddbMock, {
      userId: MOCK_USER_ID,
      orgs: [
        { orgId: MOCK_ORG_ID, role: OrgRole.Owner },
        { orgId: 'org-2', role: OrgRole.Member },
      ],
    });

    const result = await handler(billingEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
  });

  it('never claims for a membership sourced from an invitation', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: `MEMBER#${MOCK_USER_ID}` } },
      })
      .resolves({
        Item: {
          role: { S: OrgRole.Owner },
          joinedAt: { S: '2026-01-01T00:00:00.000Z' },
          source: { S: 'invitation' },
        },
      });

    const result = await handler(billingEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
  });
});
