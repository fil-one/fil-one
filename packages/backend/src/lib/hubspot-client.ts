import pRetry, { AbortError, type Options as RetryOptions } from 'p-retry';
import { Resource } from 'sst';
import type { HubSpotLifecycleStatus } from './hubspot-lifecycle-status.js';

// HubSpot subscription type ID for marketing emails. Shared across all environments
// (single HubSpot portal). Look up via:
// GET https://api.hubapi.com/communication-preferences/2026-03/definitions
export const HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID = 2233676376;

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

// Custom contact properties owned by this codebase (FIL-828). `filone_user_id`
// carries the portal's "unique value" flag, which is what allows contacts to be
// addressed by it via `idProperty` instead of by email address.
export const HUBSPOT_USER_ID_PROPERTY = 'filone_user_id';
export const HUBSPOT_SUBSCRIPTION_STATUS_PROPERTY = 'filone_subscription_status';
export const HUBSPOT_SUBSCRIPTION_STATUS_UPDATED_PROPERTY = 'filone_subscription_status_updated';

// Rides out HubSpot 429s and 5xxs. Other 4xx are not retried — a missing
// property or a revoked scope will never succeed.
const HUBSPOT_RETRY: RetryOptions = { retries: 3 };

// The default 1s/2s/4s backoff, twice over for the email-bootstrap path, does not
// fit the webhook route's 10s budget. Live writes are best-effort and the
// `hubspot-contact-sync` cron repairs what is dropped, so barely retry there.
export const HUBSPOT_WEBHOOK_RETRY: RetryOptions = { retries: 1, minTimeout: 200 };

function getAccessToken(): string {
  return Resource.HubSpotServiceKey.value;
}

/**
 * Subscribe or unsubscribe an email from a HubSpot subscription type
 * via the 2026-03 communication preferences API.
 *
 * Requires the `subscriptions-status-write` OAuth scope on the HubSpot private app.
 */
export async function updateSubscriptionStatus(
  email: string,
  subscriptionId: number,
  optedIn: boolean,
): Promise<void> {
  const token = getAccessToken();
  const subscriberId = encodeURIComponent(email);

  const resp = await fetch(
    `${HUBSPOT_BASE_URL}/communication-preferences/2026-03/statuses/${subscriberId}?channel=EMAIL`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriptionId,
        statusState: optedIn ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
        channel: 'EMAIL',
        legalBasis: 'CONSENT_WITH_NOTICE',
        legalBasisExplanation: 'User toggled marketing email preference in account settings',
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    const action = optedIn ? 'subscribe' : 'unsubscribe';
    throw new Error(`HubSpot ${action} failed (${resp.status}): ${body}`);
  }
}

/**
 * Read the current marketing-email subscription status for an email.
 * Returns false when HubSpot has no subscription record for this contact
 * (treated as opted-out — the user has never explicitly subscribed).
 */
export async function getMarketingPreference(email: string): Promise<boolean> {
  const token = getAccessToken();
  const subscriberId = encodeURIComponent(email);

  const resp = await fetch(
    `${HUBSPOT_BASE_URL}/communication-preferences/2026-03/statuses/${subscriberId}?channel=EMAIL`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (resp.status === 404) return false;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HubSpot get preferences failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as {
    subscriptionStatuses?: Array<{ id: string | number; status?: string; subscribed?: boolean }>;
  };

  const status = data.subscriptionStatuses?.find(
    (s) => String(s.id) === String(HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID),
  );
  if (!status) return false;

  return status.status === 'SUBSCRIBED';
}

/**
 * - `updated` — addressed by `filone_user_id`; the steady state.
 * - `bootstrapped` — no contact carried the id yet, so it was matched by email
 *   and stamped with the id. Later writes take the `updated` path.
 * - `unmatched` — no contact resolved at all. This is the "how many customers
 *   are we silently missing" number.
 */
export type ContactWriteOutcome = 'updated' | 'bootstrapped' | 'unmatched';

/** Thrown for any HubSpot response that is neither success nor a handled 404. */
export class HubSpotApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string, operation: string) {
    super(`HubSpot ${operation} failed (${status}): ${responseBody}`);
    this.name = 'HubSpotApiError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/** Retries 429 and 5xx; aborts immediately on any other non-OK status. */
async function hubSpotCrmFetch(
  path: string,
  init: RequestInit,
  operation: string,
  retry: RetryOptions = HUBSPOT_RETRY,
): Promise<Response> {
  const token = getAccessToken();

  return pRetry(async () => {
    const resp = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (resp.ok || resp.status === 404) return resp;

    const body = await resp.text();
    const error = new HubSpotApiError(resp.status, body, operation);
    if (resp.status === 429 || resp.status >= 500) throw error;
    throw new AbortError(error);
  }, retry);
}

/**
 * Writes a lifecycle subscription status onto a HubSpot contact, addressed by
 * our own `userId` rather than by email.
 *
 * Email is deliberately not the identity key: HubSpot's native Stripe sync app
 * already matches on it, and FIL-141 means Stripe and HubSpot can hold different
 * addresses for the same person — those contacts match nothing and keep getting
 * the emails, with no error anywhere. `email` here is used at most once per
 * contact, to bootstrap the id, so the dependency decays to zero.
 *
 * Requires the `crm.objects.contacts.write` scope.
 */
export async function upsertContactSubscriptionStatus(args: {
  userId: string;
  status: HubSpotLifecycleStatus;
  email?: string;
  /** Callers on a latency budget pass `HUBSPOT_WEBHOOK_RETRY`. */
  retry?: RetryOptions;
}): Promise<ContactWriteOutcome> {
  const { userId, status, email, retry } = args;
  const properties = {
    [HUBSPOT_SUBSCRIPTION_STATUS_PROPERTY]: status,
    [HUBSPOT_SUBSCRIPTION_STATUS_UPDATED_PROPERTY]: new Date().toISOString(),
  };

  const updated = await hubSpotCrmFetch(
    `/crm/v3/objects/contacts/${encodeURIComponent(userId)}?idProperty=${HUBSPOT_USER_ID_PROPERTY}`,
    { method: 'PATCH', body: JSON.stringify({ properties }) },
    'contact status update',
    retry,
  );

  if (updated.ok) return 'updated';

  // 404 — no contact carries this userId yet. The fallback matches on email
  // once, writing the id alongside the status so later writes take the path above.
  if (!email) return 'unmatched';

  const bootstrapped = await hubSpotCrmFetch(
    '/crm/v3/objects/contacts/batch/upsert',
    {
      method: 'POST',
      body: JSON.stringify({
        inputs: [
          {
            idProperty: 'email',
            id: email,
            properties: { ...properties, [HUBSPOT_USER_ID_PROPERTY]: userId, email },
          },
        ],
      }),
    },
    'contact bootstrap by email',
    retry,
  );

  if (!bootstrapped.ok) return 'unmatched';

  const result = (await bootstrapped.json()) as { results?: unknown[] };
  return result.results?.length ? 'bootstrapped' : 'unmatched';
}

/**
 * Currently-stored lifecycle status for a contact, or null when no contact
 * carries the id. Lets the reconciler tell "already in sync" from "repaired".
 *
 * Requires the `crm.objects.contacts.read` scope.
 */
export async function getContactSubscriptionStatus(userId: string): Promise<string | null> {
  const resp = await hubSpotCrmFetch(
    `/crm/v3/objects/contacts/${encodeURIComponent(userId)}` +
      `?idProperty=${HUBSPOT_USER_ID_PROPERTY}&properties=${HUBSPOT_SUBSCRIPTION_STATUS_PROPERTY}`,
    { method: 'GET' },
    'contact status read',
  );

  if (resp.status === 404) return null;

  const data = (await resp.json()) as { properties?: Record<string, string | null> };
  return data.properties?.[HUBSPOT_SUBSCRIPTION_STATUS_PROPERTY] ?? null;
}
