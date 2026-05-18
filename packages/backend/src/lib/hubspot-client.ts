import { Resource } from 'sst';

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

// Look up via: GET https://api.hubapi.com/communication-preferences/2026-03/definitions
const MARKETING_SUBSCRIPTION_TYPE_ID = 2233676376;

function getAccessToken(): string {
  return Resource.HubSpotServiceKey.value;
}

/**
 * Create or update a HubSpot contact by email.
 * Uses the Contacts v3 API with idProperty=email for upsert behavior.
 */
async function upsertContact(email: string): Promise<void> {
  const token = getAccessToken();

  // Try to create the contact first
  const createResp = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { email },
    }),
  });

  if (createResp.ok) return;

  // 409 means the contact already exists — that's fine
  if (createResp.status === 409) return;

  const body = await createResp.text();
  throw new Error(`HubSpot upsert contact failed (${createResp.status}): ${body}`);
}

/**
 * Subscribe or unsubscribe an email from a HubSpot subscription type
 * via the 2026-03 communication preferences API.
 *
 * Requires the `subscriptions-status-write` OAuth scope on the HubSpot private app.
 */
async function updateSubscriptionStatus(
  email: string,
  subscriptionId: number,
  optedIn: boolean,
): Promise<void> {
  const token = getAccessToken();
  const subscriberId = encodeURIComponent(email);

  const resp = await fetch(
    `${HUBSPOT_BASE_URL}/communication-preferences/2026-03/statuses/${subscriberId}`,
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
        legalBasis: 'LEGITIMATE_INTEREST_CLIENT',
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
 * Sync the marketing email preference to HubSpot.
 * Upserts the contact (in case they don't exist in HubSpot yet) then
 * updates the subscription status.
 */
export async function syncMarketingPreference(email: string, optedIn: boolean): Promise<void> {
  if (!MARKETING_SUBSCRIPTION_TYPE_ID) {
    console.warn('[hubspot] MARKETING_SUBSCRIPTION_TYPE_ID is not configured, skipping sync');
    return;
  }

  await upsertContact(email);
  await updateSubscriptionStatus(email, MARKETING_SUBSCRIPTION_TYPE_ID, optedIn);
}
