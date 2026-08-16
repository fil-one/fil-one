import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ApiErrorCode, SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import { listMemberships } from '../lib/org-membership.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { SubscriptionRecord } from '../lib/dynamo-records.js';
import { readSubscription, updateSubscription } from '../lib/subscription-store.js';
import { ensureTrialEntitlement } from '../lib/trial-entitlement.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { withRefreshedCookies } from './auth.js';

export enum AccessLevel {
  Read = 'read',
  Write = 'write',
}

type GuardRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

export function subscriptionGuardMiddleware(accessLevel: AccessLevel) {
  return {
    // Every denial carries the rotated cookies: returning a response from a
    // before hook skips the after stack that would otherwise set them, and a
    // billing block must not also log the caller out.
    before: async (request: GuardRequest) => {
      const denied = await runSubscriptionGuard(request, accessLevel);
      return denied ? withRefreshedCookies(request, denied) : undefined;
    },
  } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;
}

async function runSubscriptionGuard(
  request: GuardRequest,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const event = request.event as AuthenticatedEvent;
  const userInfo = getUserInfo(event);
  const { userId, orgId } = userInfo;

  // Consistent read so a trial just written moments earlier is visible —
  // otherwise a stale read could falsely block an entitled user. The org key is
  // preferred and the caller's own `CUSTOMER#` row is the fallback, so a member
  // rides the org's subscription rather than looking for one of their own.
  const stored = await readSubscription(orgId, userId, { consistentRead: true });

  if (!stored) return claimTrialOrDeny(userInfo);

  const record = stored.record;
  let status: string | undefined = record.subscriptionStatus;

  // No subscription status → no entitlement
  // A record can exist without a status
  if (!status) return buildInactiveResponse();

  // Store the resolved status on the event so handlers can read it
  // without a second DynamoDB query (may be updated below by lazy transitions).
  event.requestContext.subscriptionStatus = status;

  if (status === SubscriptionStatus.Active) return;

  if (status === SubscriptionStatus.Trialing) {
    const transitioned = await transitionExpiredTrial(record, { orgId, userId });
    if (!transitioned) return; // Trial still active
    status = transitioned;
    event.requestContext.subscriptionStatus = status;
  }

  if (status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.PastDue) {
    return handleGracePeriod(record, accessLevel);
  }

  if (status === SubscriptionStatus.Canceled) {
    return buildCanceledResponse();
  }

  // Inactive is a read-model value (never persisted), but if it ever reaches a
  // record, blocking is the stated contract — not an accident of fail-closed.
  if (status === SubscriptionStatus.Inactive) {
    return buildInactiveResponse();
  }

  // Unknown or unhandled status → block (fail closed)
  return buildInactiveResponse();
}

/**
 * The org has no subscription row. The only path that creates one from a gated
 * request is the lazy trial claim, and this is the one claim point in the
 * system (ADR §4 removed the two on the login path).
 *
 * Only entitled — verified, claim-owning — users get a trial, and only a person
 * can claim one. An API key session is not a login: its `sub` names the key
 * rather than an identity row, so claiming under it would write a trial keyed
 * to a credential and stamp the claim flag on a row that does not exist. A key
 * whose org has no billing record is simply not entitled.
 */
async function claimTrialOrDeny(
  userInfo: UserInfo,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const { sub, userId, orgId, email, emailVerified, apiKeySession } = userInfo;
  if (apiKeySession) return buildInactiveResponse();
  if (!(await isSoloPersonalOrg(userInfo))) return buildOrgBillingInactiveResponse();

  const entitled = await ensureTrialEntitlement({
    sub,
    userId,
    orgId,
    email: email ?? null,
    emailVerified,
  });
  return entitled ? undefined : buildInactiveResponse();
}

/**
 * Whether this request may spend the caller's trial entitlement.
 *
 * Only in their own org, and only while it is the only one they belong to
 * (ADR §5). Without the personal-org condition the guard would create Stripe
 * billing on somebody else's org, anchoring that org's subscription to this
 * caller's Stripe customer; without the sole-membership condition, every
 * employee of an org who ever opened their personal dashboard would mint a
 * trial nobody asked for. A member who genuinely wants personal use activates
 * billing explicitly, and their claim is still theirs to spend.
 *
 * Decided from stored rows, never from the request: `X-Org-Id` names the org
 * but cannot prove whose it is. `source` says how the membership came to be —
 * an invitation is somebody else's org by construction — and the inverse items
 * say how many orgs the caller belongs to.
 */
async function isSoloPersonalOrg({ userId, orgId, membership }: UserInfo): Promise<boolean> {
  if (!membership || membership.orgId !== orgId) return false;
  if (membership.source === 'invitation') return false;

  const memberships = await listMemberships(userId);
  return memberships.length === 1 && memberships[0]?.orgId === orgId;
}

/**
 * If the trial has expired, transition the record to grace_period and mutate
 * `record.gracePeriodEndsAt` in place so the caller can continue processing
 * as a grace-period record. Returns the new status, or null if still trialing.
 */
async function transitionExpiredTrial(
  record: SubscriptionRecord,
  owner: { orgId: string; userId: string },
): Promise<SubscriptionStatus.GracePeriod | null> {
  const { trialEndsAt } = record;
  if (!trialEndsAt || new Date(trialEndsAt).getTime() >= Date.now()) {
    return null;
  }

  // Lazy transition: trial expired → grace_period
  const gracePeriodEndsAt = addDays(new Date(trialEndsAt), TRIAL_GRACE_DAYS).toISOString();
  await updateSubscription(owner, {
    UpdateExpression:
      'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
    ExpressionAttributeValues: {
      ':status': { S: SubscriptionStatus.GracePeriod },
      ':grace': { S: gracePeriodEndsAt },
      ':now': { S: new Date().toISOString() },
    },
  });
  record.gracePeriodEndsAt = gracePeriodEndsAt;
  return SubscriptionStatus.GracePeriod;
}

async function handleGracePeriod(
  record: SubscriptionRecord,
  accessLevel: AccessLevel,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const { gracePeriodEndsAt } = record;
  if (gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < Date.now()) {
    // Grace expired → respond as canceled, but do NOT persist the transition
    // here. Persisting `canceled` from this read/hot path flips the record out
    // of `grace_period` without disabling the tenant at the orchestrator — and
    // the grace-period-enforcer only scans `grace_period`, so the record would
    // become invisible to the one job that disables tenants, leaving standing
    // S3 access keys with data-plane access indefinitely. Leave the record in
    // `grace_period` so the enforcer owns the terminal cancel + tenant disable.
    return buildCanceledResponse();
  }

  if (accessLevel === AccessLevel.Write) {
    return new ResponseBuilder()
      .status(403)
      .body({
        message:
          'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
        code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
      })
      .build();
  }

  // Read access within grace period → allow
  return;
}

function buildCanceledResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    })
    .build();
}

/**
 * The org has no subscription and this caller is not the person who can create
 * one. Its own code so the console can say who to ask instead of showing the
 * account-holder's "update your payment method".
 *
 * The message names the Owner role rather than a person: resolving which human
 * that is costs a query on a denial path, and a ReadOnly member is not owed
 * another member's email address.
 */
function buildOrgBillingInactiveResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message:
        'This organization does not have billing set up. An Owner of the organization can add a payment method.',
      code: ApiErrorCode.ORG_BILLING_INACTIVE,
    })
    .build();
}

function buildInactiveResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message:
        'Your subscription is not active. Please contact support or update your payment method.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
    })
    .build();
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
