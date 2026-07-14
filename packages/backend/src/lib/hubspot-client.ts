import { Resource } from 'sst';

// HubSpot subscription type ID for marketing emails. Shared across all environments
// (single HubSpot portal). Look up via:
// GET https://api.hubapi.com/communication-preferences/2026-03/definitions
export const HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID = 2233676376;

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

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
