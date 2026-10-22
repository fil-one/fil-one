import { PAID_GRACE_DAYS, Stage, SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import type { TenantStatus } from '@filone/shared';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
  type RegionSyncOutcome,
} from '../lib/region-helpers.ts';
import { listMemberships } from '../lib/org-membership.ts';
import {
  getSubscription,
  isConditionalCheckFailure,
  updateSubscription,
} from '../lib/subscription-store.ts';
import { readHomeOrgPointers } from '../lib/user-profile.ts';

// Puts an E2E test account into a known state: its org's billing row and the
// tenant status in every region it is provisioned in. The E2E suite (tests/e2e)
// invokes it before each run and around the specs that change an account's
// state. It is never deployed to production (sst.config.ts) and refuses to run
// there.

/**
 * The states an E2E account can be put in. `paid`, `unpaid`, `trial` and
 * `disabled` are the states the E2E roles rest in. The two grace period states
 * are the two ways production enters `grace_period`: a canceled subscription,
 * and a trial that ended without one.
 */
export type AccountState =
  | 'paid'
  | 'unpaid'
  | 'trial'
  | 'disabled'
  | 'paid_grace_period'
  | 'trial_grace_period';

export interface AccountStateTestHelperEvent {
  userId: string;
  state: AccountState;
}

export interface AccountStateTestHelperResult {
  orgId: string;
  subscriptionStatus: SubscriptionStatus;
  regions: Array<Pick<RegionSyncOutcome, 'orchestratorId' | 'tenantId' | 'outcome'>>;
}

interface AccountStateDefinition {
  subscriptionStatus: SubscriptionStatus;
  /** Date attributes the state sets, computed from the time of the call. */
  getDates: (now: number) => Record<string, string>;
  tenantStatus: TenantStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ACCOUNT_STATES: Record<AccountState, AccountStateDefinition> = {
  paid: {
    subscriptionStatus: SubscriptionStatus.Active,
    getDates: (now) => ({ currentPeriodEnd: formatIsoDate(now + 30 * DAY_MS) }),
    tenantStatus: 'active',
  },
  unpaid: {
    subscriptionStatus: SubscriptionStatus.PastDue,
    getDates: (now) => ({
      currentPeriodEnd: formatIsoDate(now + 30 * DAY_MS),
      lastPaymentFailedAt: formatIsoDate(now - DAY_MS),
    }),
    tenantStatus: 'active',
  },
  trial: {
    subscriptionStatus: SubscriptionStatus.Trialing,
    getDates: (now) => ({ trialEndsAt: formatIsoDate(now + 14 * DAY_MS) }),
    tenantStatus: 'active',
  },
  disabled: {
    subscriptionStatus: SubscriptionStatus.Canceled,
    getDates: () => ({}),
    tenantStatus: 'disabled',
  },
  // A paid subscription Stripe canceled a day ago (stripe-event-worker).
  paid_grace_period: {
    subscriptionStatus: SubscriptionStatus.GracePeriod,
    getDates: (now) => ({
      canceledAt: formatIsoDate(now - DAY_MS),
      gracePeriodEndsAt: formatIsoDate(now - DAY_MS + PAID_GRACE_DAYS * DAY_MS),
    }),
    tenantStatus: 'write-locked',
  },
  // A trial that ended a day ago with no subscription (the subscription guard's
  // lazy transition). Production write-locks the tenants on the enforcer's next
  // run; this state sets the lock right away.
  trial_grace_period: {
    subscriptionStatus: SubscriptionStatus.GracePeriod,
    getDates: (now) => ({
      trialEndsAt: formatIsoDate(now - DAY_MS),
      gracePeriodEndsAt: formatIsoDate(now - DAY_MS + TRIAL_GRACE_DAYS * DAY_MS),
    }),
    tenantStatus: 'write-locked',
  },
};

// The cancellation and payment-failure markers. A state that does not set one
// removes it, so the guard and the billing page never read a marker the
// previous state left behind. The other dates stay until a state sets them
// again, as the E2E billing reset leaves them today: only a `trialing` row
// reads `trialEndsAt`.
const STATE_SPECIFIC_ATTRIBUTES = ['gracePeriodEndsAt', 'canceledAt', 'lastPaymentFailedAt'];

export async function handler(event: unknown): Promise<AccountStateTestHelperResult> {
  if (process.env.FILONE_STAGE === Stage.Production) {
    throw new Error('[account-state-test-helper] Refusing to run in production');
  }
  const { userId, state } = parseEvent(event);
  const definition = ACCOUNT_STATES[state];

  const orgId = await resolveHomeOrgId(userId);

  // Checked before any tenant changes, so `disabled` does not disable the
  // tenants of an account whose row the write would then refuse. The write
  // stays conditioned on the row, for a row deleted in between.
  if (!(await getSubscription(orgId, { consistentRead: true, projectionExpression: 'pk' }))) {
    throw createMissingBillingRowError(orgId, userId);
  }

  // Production disables the tenants before it writes `canceled` (the grace-period
  // enforcer). It writes the row before it re-activates them (activate-subscription)
  // or write-locks them (the Stripe cancellation).
  let outcomes: RegionSyncOutcome[];
  if (definition.tenantStatus === 'disabled') {
    outcomes = await syncTenants(orgId, definition.tenantStatus);
    await writeBillingRow(orgId, userId, definition);
  } else {
    await writeBillingRow(orgId, userId, definition);
    outcomes = await syncTenants(orgId, definition.tenantStatus);
  }

  return {
    orgId,
    subscriptionStatus: definition.subscriptionStatus,
    regions: outcomes.map(({ orchestratorId, tenantId, outcome }) => ({
      orchestratorId,
      tenantId,
      outcome,
    })),
  };
}

function parseEvent(event: unknown): AccountStateTestHelperEvent {
  const { userId, state } = (event ?? {}) as Partial<
    Record<keyof AccountStateTestHelperEvent, unknown>
  >;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(
      `[account-state-test-helper] Invalid event: userId must be a non-empty string, got ${JSON.stringify(userId)}`,
    );
  }
  if (!isAccountState(state)) {
    throw new Error(
      `[account-state-test-helper] Invalid event: state must be one of ` +
        `${Object.keys(ACCOUNT_STATES).join(', ')}, got ${JSON.stringify(state)}`,
    );
  }
  return { userId, state };
}

function isAccountState(value: unknown): value is AccountState {
  return typeof value === 'string' && Object.hasOwn(ACCOUNT_STATES, value);
}

/**
 * The org the account signed up with. A profile row written before it carried
 * `orgId` falls back to the first org the user belongs to. A profile that
 * cannot be read fails the call: the first membership of a user in several
 * orgs may be somebody else's org.
 */
async function resolveHomeOrgId(userId: string): Promise<string> {
  const { profileOrgId } = await readHomeOrgPointers(userId);
  if (profileOrgId) return profileOrgId;

  const [firstMembership] = await listMemberships(userId);
  if (firstMembership) {
    console.warn(
      '[account-state-test-helper] No orgId on the profile, using the first membership',
      {
        userId,
        orgId: firstMembership.orgId,
      },
    );
    return firstMembership.orgId;
  }

  throw new Error(
    `[account-state-test-helper] User ${userId} has no home org: USER#${userId}/PROFILE names ` +
      'none and the user belongs to no org',
  );
}

async function syncTenants(orgId: string, status: TenantStatus): Promise<RegionSyncOutcome[]> {
  // Consistent, so a region provisioned moments ago is not skipped.
  const outcomes = await syncTenantStatusInProvisionedRegions(orgId, status, { consistent: true });
  assertRegionSyncSucceeded(outcomes);
  return outcomes;
}

/**
 * Set the state's status and dates on the org's existing row. The invariant
 * fields the account was created with (orgId, stripeCustomerId, subscriptionId,
 * trialStartedAt, currentPeriodStart) are left alone.
 */
async function writeBillingRow(
  orgId: string,
  userId: string,
  definition: AccountStateDefinition,
): Promise<void> {
  const attributes: Record<string, string> = {
    subscriptionStatus: definition.subscriptionStatus,
    ...definition.getDates(Date.now()),
    updatedAt: new Date().toISOString(),
  };
  const removed = STATE_SPECIFIC_ATTRIBUTES.filter((name) => !Object.hasOwn(attributes, name));

  const names: Record<string, string> = {};
  const values: Record<string, { S: string }> = {};
  const sets = Object.entries(attributes).map(([name, value], i) => {
    names[`#s${i}`] = name;
    values[`:s${i}`] = { S: value };
    return `#s${i} = :s${i}`;
  });
  const removes = removed.map((name, i) => {
    names[`#r${i}`] = name;
    return `#r${i}`;
  });

  try {
    await updateSubscription(
      { orgId, userId },
      {
        UpdateExpression:
          `SET ${sets.join(', ')}` + (removes.length ? ` REMOVE ${removes.join(', ')}` : ''),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    );
  } catch (err) {
    if (isConditionalCheckFailure(err)) throw createMissingBillingRowError(orgId, userId, err);
    throw err;
  }
}

function createMissingBillingRowError(orgId: string, userId: string, cause?: unknown): Error {
  return new Error(
    `[account-state-test-helper] Org ${orgId} (user ${userId}) has no billing row at ` +
      `ORG#${orgId}/SUBSCRIPTION. Pre-seed it (orgId, userId, stripeCustomerId, subscriptionId) first.`,
    { cause },
  );
}

function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString();
}
