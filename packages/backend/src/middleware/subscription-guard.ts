import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ApiErrorCode, SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { SubscriptionRecord } from '../lib/dynamo-records.js';
import { readSubscription, updateSubscription } from '../lib/subscription-store.js';
import { claimTrialIfEligible, isTrialClaimable } from '../lib/trial-claim.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { withRefreshedCookies } from './auth.js';

export const AccessLevel = {
  Read: 'read',
  Write: 'write',
} as const;
export type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];

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
  // otherwise a stale read could falsely block an entitled user. The row is the
  // org's, so a member rides the org's subscription rather than looking for one
  // of their own.
  const record = await readSubscription(orgId, { consistentRead: true });

  // No record, or the customer-mapping-only row an abandoned payment modal
  // leaves behind: both leave the trial claim open, and the claim upgrades the
  // row rather than replacing it.
  if (!record || isTrialClaimable(record)) return claimTrialOrDeny(userInfo);

  let status: string | undefined = record.subscriptionStatus;

  // A record can exist without a status and without being claimable — it holds a
  // subscription id, so somebody's subscription is behind it and the status will
  // arrive by webhook. No entitlement until it does.
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
 * The trial claim is open for this org, so spend it or say why not.
 *
 * The claim itself lives in lib/trial-claim.ts, shared with GET /api/billing —
 * the dashboard's first call sits behind no guard, and the two must agree on who
 * is eligible or an organic signup gets a different answer depending on which
 * route it happens to hit first.
 *
 * An API key session is not a login: its `sub` names the key rather than an
 * identity row, so claiming under it would write a trial keyed to a credential.
 * A key whose org has no billing record is simply not entitled.
 */
async function claimTrialOrDeny(
  userInfo: UserInfo,
): Promise<APIGatewayProxyStructuredResultV2 | void> {
  const outcome = await claimTrialIfEligible(userInfo);
  if (outcome === 'claimed') return undefined;
  // The claim refused because a pre-re-key `CUSTOMER#` row is still standing:
  // this org has billing the org key cannot see, so its state is unknown here
  // rather than inactive.
  if (outcome === 'legacy-row') return buildBillingUnavailableResponse();
  if (outcome === 'not-own-org') return buildOrgBillingInactiveResponse();
  return buildInactiveResponse();
}

/**
 * If the trial has expired, transition the record to grace_period and mutate
 * `record.gracePeriodEndsAt` in place so the caller can continue processing
 * as a grace-period record. Returns the new status, or null if still trialing.
 */
async function transitionExpiredTrial(
  record: SubscriptionRecord,
  owner: { orgId: string; userId: string },
): Promise<typeof SubscriptionStatus.GracePeriod | null> {
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
 * The org has no subscription and this caller cannot spend a trial claim on it.
 * Its own code so the console can name the role that sets billing up instead of
 * showing the account-holder's "update your payment method".
 *
 * The message names the Owner role rather than a person, and does not tell the
 * reader to go and ask one: an Owner of a second org reaches this too, and being
 * told to ask themselves reads as a bug. Resolving which human owns the org
 * would cost a query on a denial path, and a ReadOnly member is not owed another
 * member's email address either way.
 */
function buildOrgBillingInactiveResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body({
      message:
        'This organization does not have billing set up. Adding a payment method for it requires the Owner role.',
      code: ApiErrorCode.ORG_BILLING_INACTIVE,
    })
    .build();
}

/**
 * The account has billing this deploy cannot address — a row the re-key left
 * behind.
 *
 * The 503 is what separates this from an inactive subscription: it says the same
 * thing to the customer and to the on-call, come back, somebody is looking at
 * it, and it carries no instruction to update a payment method there is nothing
 * wrong with. The code stays `SUBSCRIPTION_INACTIVE`, shared with the read-side
 * twin in `get-billing` and with the plain denial, so the runbook's post-flip
 * watch on the denial rate sees every refusal the re-key can cause on one
 * signal.
 */
function buildBillingUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body({
      message: 'Billing is temporarily unavailable for this account. Please try again shortly.',
      code: ApiErrorCode.SUBSCRIPTION_INACTIVE,
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
