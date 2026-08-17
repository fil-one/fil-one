import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { ApiErrorCode } from '@filone/shared';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import {
  expectErrorResponse,
  expectRefreshedCookies,
  REFRESHED_TOKENS,
} from '../test/assert-helpers.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

vi.mock('../lib/user-context.js', () => ({
  getUserInfo: (event: AuthenticatedEvent) => event.requestContext.userInfo,
}));

vi.mock('../lib/trial-entitlement.js', () => ({
  ensureTrialEntitlement: vi.fn(),
}));

vi.mock('../lib/org-membership.js', () => ({
  listMemberships: vi.fn(),
}));

const ddbMock = mockClient(DynamoDBClient);

import { subscriptionGuardMiddleware, AccessLevel } from './subscription-guard.js';
import { listMemberships } from '../lib/org-membership.js';
import { ensureTrialEntitlement } from '../lib/trial-entitlement.js';
import { OrgRole, SubscriptionStatus } from '@filone/shared';

const mockEnsureTrialEntitlement = vi.mocked(ensureTrialEntitlement);
const mockListMemberships = vi.mocked(listMemberships);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function billingItem(fields: Parameters<typeof marshall>[0]) {
  return { Item: marshall(fields, { removeUndefinedValues: true }) };
}

const USER_ID = 'test-user-uuid';
const ORG_ID = 'test-org-uuid';
const OTHER_ORG_ID = 'someone-elses-org-uuid';

/**
 * A caller in their own org — the membership row `authMiddleware` attaches.
 * Whether that org is their only one is a separate fact, stated by
 * `mockListMemberships`, which defaults to solo.
 */
function soloOwner(overrides: Record<string, unknown> = {}) {
  return buildEvent({
    userInfo: {
      sub: 'auth0|sub-1',
      userId: USER_ID,
      orgId: ORG_ID,
      email: 'test@example.com',
      emailVerified: true,
      membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner, source: 'signup' },
      ...overrides,
    },
  });
}

const SOLO_MEMBERSHIPS = [{ orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' }];

/** The denial a caller gets in an org whose billing is somebody else's to set up. */
const ORG_BILLING_DENIAL = {
  message:
    'This organization does not have billing set up. Adding a payment method for it requires the Owner role.',
  code: ApiErrorCode.ORG_BILLING_INACTIVE,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscriptionGuardMiddleware', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.restoreAllMocks();
    mockListMemberships.mockResolvedValue(SOLO_MEMBERSHIPS);
    // The read asks both keys at once; absent unless a test says otherwise.
    ddbMock.on(GetItemCommand).resolves({});
  });

  it('refuses to mint a trial while a pre-re-key CUSTOMER# row is still standing', async () => {
    // That row means the backfill missed this account, so the org already has
    // billing this deploy cannot see. Minting would give one account two Stripe
    // customers, two subscriptions and two meters — not something a later run
    // can undo.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } } })
      .resolves({})
      .on(GetItemCommand, { Key: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } } })
      .resolves({ Item: { pk: { S: `CUSTOMER#${USER_ID}` } } });

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(buildMiddyRequest(soloOwner()));

    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    // Denied loudly, not quietly served: the customer sees a retryable error and
    // the on-call sees a metric.
    expectErrorResponse(result, 503, {
      message: 'Billing is temporarily unavailable for this account. Please try again shortly.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    });
    errorSpy.mockRestore();
  });

  it('allows when no billing record exists and the user is entitled to a trial', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockEnsureTrialEntitlement.mockResolvedValue(true);

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(buildMiddyRequest(soloOwner()));

    expect(result).toBeUndefined();
    expect(mockEnsureTrialEntitlement).toHaveBeenCalledWith({
      sub: 'auth0|sub-1',
      userId: USER_ID,
      orgId: ORG_ID,
      email: 'test@example.com',
      emailVerified: true,
    });
  });

  it('blocks (inactive) when no billing record exists and the user is not entitled', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockEnsureTrialEntitlement.mockResolvedValue(false);

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(buildMiddyRequest(soloOwner({ emailVerified: false })));

    expectErrorResponse(result, 403, {
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it('propagates a transient entitlement error (retryable 5xx) instead of masking it as 403', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockEnsureTrialEntitlement.mockRejectedValue(new Error('DynamoDB unavailable'));

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);

    await expect(before(buildMiddyRequest(soloOwner()))).rejects.toThrow('DynamoDB unavailable');
  });

  it('serves a member from the org row with one read', async () => {
    // The whole point of the re-key: a member who has never had a billing row of
    // their own rides the org's subscription.
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } } })
      .resolves(
        billingItem({
          pk: `ORG#${ORG_ID}`,
          sk: 'SUBSCRIPTION',
          orgId: ORG_ID,
          subscriptionStatus: SubscriptionStatus.Active,
        }),
      );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(
        buildEvent({ userInfo: { userId: 'a-member-with-no-row', orgId: ORG_ID } }),
      ),
    );

    expect(result).toBeUndefined();
    // One read, on the org's key. Which member is asking does not change the
    // answer, so there is no second key to try.
    const reads = ddbMock.commandCalls(GetItemCommand);
    expect(reads.map((read) => read.args[0].input.Key)).toStrictEqual([
      { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } },
    ]);
  });

  it('allows when subscription status is active', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Active,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('allows when trialing and trial has not expired', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: futureDate,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('transitions trialing → grace_period when trial expired', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();

    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: pastDate,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    // Read access during grace period → allowed
    expect(result).toBeUndefined();

    // The transition lands on the org's row, which is the row every read of it
    // will find, and asserts it is still there — this is an update to a record
    // the request read a moment ago, never a reason to create one.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } },
      ConditionExpression: 'attribute_exists(pk)',
      UpdateExpression:
        'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        ':grace': { S: expect.any(String) },
        ':now': { S: expect.any(String) },
      },
    });
  });

  it('blocks write access during grace period', async () => {
    const futureGrace = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: futureGrace,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message:
        'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
      code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
    });
  });

  it('allows read access during grace period', async () => {
    const futureGrace = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: futureGrace,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('responds canceled when grace expired but does NOT persist the transition', async () => {
    const pastGrace = new Date(Date.now() - 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: pastGrace,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    });

    // Must NOT write `canceled` from this hot path: the record stays in
    // `grace_period` so the grace-period-enforcer can still see it and disable
    // the tenant. Persisting `canceled` here would hide the record from the
    // enforcer, leaving the tenant enabled.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('blocks a record that holds a subscription but no status yet (fail closed)', async () => {
    // A record whose status has not arrived by webhook yet grants nothing —
    // entitlement comes only from ensureTrialEntitlement. (A record with no
    // subscription at all is a different case: the trial claim is still open on
    // it, and the block would forfeit it. See the claim tests below.)
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        stripeCustomerId: 'cus_123',
        subscriptionId: 'sub_123',
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it('blocks when subscriptionStatus is inactive (fail closed)', async () => {
    // `inactive` is a read-model value that is never persisted; if it ever
    // reaches a record anyway, the guard must deny it explicitly — the same
    // answer GET /api/billing reports for accounts without entitlement.
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Inactive,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it.each(['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'some_future_status'])(
    'blocks access when status is unknown: %s (fail closed)',
    async (unknownStatus) => {
      ddbMock.on(GetItemCommand).resolves(
        billingItem({
          pk: `ORG#${ORG_ID}`,
          sk: 'SUBSCRIPTION',
          orgId: ORG_ID,
          subscriptionStatus: unknownStatus,
        }),
      );

      const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
      const result = await before(
        buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
      );

      expectErrorResponse(result, 403, {
        message:
          'Your subscription is not active. Please contact support or update your payment method.',
        code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
      });
    },
  );

  it('blocks read access for unknown statuses too (fail closed)', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: 'incomplete',
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it('blocks access when status is directly canceled (not via grace expiry)', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Canceled,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    });
  });

  it('carries the rotated cookies on a billing denial', async () => {
    // A billing block is a screen the caller can act on. Losing the session
    // this request refreshed would send them to the login page instead.
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `ORG#${ORG_ID}`,
        sk: 'SUBSCRIPTION',
        orgId: ORG_ID,
        subscriptionStatus: SubscriptionStatus.Canceled,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } }), {
        internal: { newTokens: REFRESHED_TOKENS },
      }),
    );

    expectRefreshedCookies(result);
  });

  // The four properties ADR §4/§5 pins on the trial claim are stated there in
  // terms of invitations, which do not exist yet. Each one reduces to a
  // condition on this guard — the system's only claim point since the login
  // path's two were removed — so each is pinned by the mechanics it reduces to.
  // When the invite flow lands, these are the tests it must not break.
  describe('the lazy trial claim is confined to the caller’s own solo org', () => {
    /** A caller acting in an org they were invited into. */
    const invitedMember = () => {
      mockListMemberships.mockResolvedValue([
        { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' },
        { orgId: OTHER_ORG_ID, role: OrgRole.Member, joinedAt: '' },
      ]);
      return buildMiddyRequest(
        buildEvent({
          userInfo: {
            sub: 'auth0|sub-1',
            userId: USER_ID,
            orgId: OTHER_ORG_ID,
            email: 'test@example.com',
            emailVerified: true,
            membership: {
              orgId: OTHER_ORG_ID,
              userId: USER_ID,
              role: OrgRole.Member,
              source: 'invitation',
            },
          },
        }),
      );
    };

    beforeEach(() => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      // The module mock's call log outlives restoreAllMocks.
      mockEnsureTrialEntitlement.mockClear();
    });

    it('joining an org creates no trial in it', async () => {
      const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
      const result = await before(invitedMember());

      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
      expectErrorResponse(result, 403, ORG_BILLING_DENIAL);
    });

    it('a member whose email lost the entitlement race is denied on billing, not on eligibility', async () => {
      // `ensureTrialEntitlement` is the only reader and writer of the
      // `EMAIL_NORM#` suppression records. Never calling it is what makes a
      // suppressed address irrelevant to org access: the denial below is about
      // the org's billing and would read the same for any member.
      const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
      const result = await before(invitedMember());

      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
      expectErrorResponse(result, 403, ORG_BILLING_DENIAL);
    });

    it('acting in another org leaves the caller’s own claim unspent', async () => {
      const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
      await before(invitedMember());
      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();

      // The same person, same request cycle, in the org that is theirs: the
      // claim is still there to spend, and it is spent on their own org.
      mockEnsureTrialEntitlement.mockResolvedValue(true);
      mockListMemberships.mockResolvedValue(SOLO_MEMBERSHIPS);

      expect(await before(buildMiddyRequest(soloOwner()))).toBeUndefined();
      expect(mockEnsureTrialEntitlement).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID }),
      );
    });

    it('a member of another org causes no billing write for it', async () => {
      const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
      await before(invitedMember());

      // Not "no write with the wrong key" — no write at all. A Stripe customer
      // created here would anchor that org's subscription to this caller.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('a second membership suppresses the claim even in the caller’s own org', async () => {
      // Otherwise every employee who ever opened their personal dashboard would
      // mint a Stripe trial nobody wanted.
      mockListMemberships.mockResolvedValue([
        { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' },
        { orgId: OTHER_ORG_ID, role: OrgRole.Member, joinedAt: '' },
      ]);

      const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
      const result = await before(buildMiddyRequest(soloOwner()));

      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
      expectErrorResponse(result, 403, ORG_BILLING_DENIAL);
    });
  });

  describe('an API key session', () => {
    // The RAG bearer path builds its caller from the key record, so `sub` names
    // the key. Claiming a trial under it would write billing state keyed to a
    // credential and stamp the claim flag on an identity row that does not
    // exist.
    const keyCaller = () =>
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            sub: 'ragkey|key-1',
            userId: USER_ID,
            orgId: 'test-org-uuid',
            email: 'creator@example.com',
            emailVerified: true,
            apiKeySession: true,
          },
        }),
      );

    it('provisions no trial for an org with no billing record', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });
      // The module mock's call log outlives restoreAllMocks, so the claim this
      // test is about has to be counted from here.
      mockEnsureTrialEntitlement.mockClear();

      const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
      const result = await before(keyCaller());

      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
      expectErrorResponse(result, 403, {
        message:
          'Your subscription is not active. Please contact support or update your payment method.',
        code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
      });
    });

    it('is served normally when the org does have one', async () => {
      ddbMock.on(GetItemCommand).resolves(
        billingItem({
          pk: `ORG#${ORG_ID}`,
          sk: 'SUBSCRIPTION',
          orgId: ORG_ID,
          subscriptionStatus: SubscriptionStatus.Active,
        }),
      );

      const { before } = subscriptionGuardMiddleware(AccessLevel.Read);

      expect(await before(keyCaller())).toBeUndefined();
    });
  });
});
