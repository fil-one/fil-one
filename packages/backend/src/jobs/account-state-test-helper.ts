import { Stage, SubscriptionStatus } from '@filone/shared';
import type { TenantStatus } from '@filone/shared';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
  type RegionSyncOutcome,
} from '../lib/region-helpers.ts';
import { listMemberships } from '../lib/org-membership.ts';
import { isConditionalCheckFailure, updateSubscription } from '../lib/subscription-store.ts';
import { readUserProfile } from '../lib/user-profile.ts';

// Puts an E2E test account into a known state: its org's billing row and the
// tenant status in every region it is provisioned in. The E2E suite (tests/e2e)
// invokes it before each run and around the specs that change an account's
// state. It is never deployed to production (sst.config.ts) and refuses to run
// there.

/** The states the E2E roles rest in, named after the roles. */
export type AccountState = 'paid' | 'unpaid' | 'trial' | 'disabled';

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
  dates: (now: number) => Record<string, string>;
  tenantStatus: TenantStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ACCOUNT_STATES: Record<AccountState, AccountStateDefinition> = {
  paid: {
    subscriptionStatus: SubscriptionStatus.Active,
    dates: (now) => ({ currentPeriodEnd: isoDate(now + 30 * DAY_MS) }),
    tenantStatus: 'active',
  },
  unpaid: {
    subscriptionStatus: SubscriptionStatus.PastDue,
    dates: (now) => ({
      currentPeriodEnd: isoDate(now + 30 * DAY_MS),
      lastPaymentFailedAt: isoDate(now - DAY_MS),
    }),
    tenantStatus: 'active',
  },
  trial: {
    subscriptionStatus: SubscriptionStatus.Trialing,
    dates: (now) => ({ trialEndsAt: isoDate(now + 14 * DAY_MS) }),
    tenantStatus: 'active',
  },
  disabled: {
    subscriptionStatus: SubscriptionStatus.Canceled,
    dates: () => ({}),
    tenantStatus: 'disabled',
  },
};

// Attributes a state change removes unless the new state sets them, so a value
// one state wrote cannot leak into the next.
const STATE_SPECIFIC_ATTRIBUTES = ['gracePeriodEndsAt', 'canceledAt', 'lastPaymentFailedAt'];

export async function handler(event: unknown): Promise<AccountStateTestHelperResult> {
  if (process.env.FILONE_STAGE === Stage.Production) {
    throw new Error('[account-state-test-helper] Refusing to run in production');
  }
  const { userId, state } = parseEvent(event);
  const definition = ACCOUNT_STATES[state];

  const orgId = await resolveHomeOrgId(userId);

  // Production disables the tenants before it writes `canceled` (the grace-period
  // enforcer), and writes the row before it re-activates them (activate-subscription).
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
  if (typeof state !== 'string' || !Object.hasOwn(ACCOUNT_STATES, state)) {
    throw new Error(
      `[account-state-test-helper] Invalid event: state must be one of ` +
        `${Object.keys(ACCOUNT_STATES).join(', ')}, got ${JSON.stringify(state)}`,
    );
  }
  return { userId, state: state as AccountState };
}

/**
 * The org the account signed up with. A profile row written before it carried
 * `orgId` falls back to the first org the user belongs to.
 */
async function resolveHomeOrgId(userId: string): Promise<string> {
  const profileOrgId = (await readUserProfile(userId, { consistentRead: true }))?.orgId;
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
      'none (or could not be read) and the user belongs to no org',
  );
}

async function syncTenants(orgId: string, status: TenantStatus): Promise<RegionSyncOutcome[]> {
  const outcomes = await syncTenantStatusInProvisionedRegions(orgId, status);
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
    ...definition.dates(Date.now()),
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
    if (isConditionalCheckFailure(err)) {
      throw new Error(
        `[account-state-test-helper] Org ${orgId} (user ${userId}) has no billing row at ` +
          `ORG#${orgId}/SUBSCRIPTION. Pre-seed it (orgId, userId, stripeCustomerId, subscriptionId) first.`,
        { cause: err },
      );
    }
    throw err;
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}
