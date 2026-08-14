import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    HubSpotServiceKey: { value: 'test-service-key' },
  },
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import {
  HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID,
  getContactSubscriptionStatus,
  getMarketingPreference,
  upsertContactSubscriptionStatus,
  updateSubscriptionStatus,
} from './hubspot-client.js';
import { HubSpotLifecycleStatus } from './hubspot-lifecycle-status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUSES_BASE = 'https://api.hubapi.com/communication-preferences/2026-03/statuses/';

function ok(status = 200) {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
}

function fail(status: number, body = 'boom') {
  return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// updateSubscriptionStatus
// ---------------------------------------------------------------------------

const MARKETING_ID = HUBSPOT_MARKETING_SUBSCRIPTION_TYPE_ID;

describe('updateSubscriptionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts SUBSCRIBED on opt-in', async () => {
    mockFetch.mockResolvedValueOnce(ok(200));

    await updateSubscriptionStatus('user@example.com', MARKETING_ID, true);

    expect(mockFetch.mock.calls).toHaveLength(1);
    const [statusCall] = mockFetch.mock.calls;

    expect(statusCall[0]).toBe(`${STATUSES_BASE}user%40example.com?channel=EMAIL`);
    expect(statusCall[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-service-key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(statusCall[1]!.body as string)).toEqual({
      subscriptionId: MARKETING_ID,
      statusState: 'SUBSCRIBED',
      channel: 'EMAIL',
      legalBasis: 'CONSENT_WITH_NOTICE',
      legalBasisExplanation: 'User toggled marketing email preference in account settings',
    });
  });

  it('sends UNSUBSCRIBED on opt-out', async () => {
    mockFetch.mockResolvedValueOnce(ok(200));

    await updateSubscriptionStatus('user@example.com', MARKETING_ID, false);

    const [statusCall] = mockFetch.mock.calls;
    expect(JSON.parse(statusCall[1]!.body as string).statusState).toBe('UNSUBSCRIBED');
  });

  it('throws with "subscribe" wording when status update fails on opt-in', async () => {
    mockFetch.mockResolvedValueOnce(fail(403, 'scope missing'));

    await expect(updateSubscriptionStatus('user@example.com', MARKETING_ID, true)).rejects.toThrow(
      /HubSpot subscribe failed \(403\): scope missing/,
    );
  });

  it('throws with "unsubscribe" wording when status update fails on opt-out', async () => {
    mockFetch.mockResolvedValueOnce(fail(400, 'bad'));

    await expect(updateSubscriptionStatus('user@example.com', MARKETING_ID, false)).rejects.toThrow(
      /HubSpot unsubscribe failed \(400\): bad/,
    );
  });

  it('URL-encodes special characters in the email path segment', async () => {
    mockFetch.mockResolvedValueOnce(ok(200));

    await updateSubscriptionStatus('user+tag@example.com', MARKETING_ID, true);

    const [statusCall] = mockFetch.mock.calls;
    expect(statusCall[0]).toBe(`${STATUSES_BASE}user%2Btag%40example.com?channel=EMAIL`);
  });
});

// ---------------------------------------------------------------------------
// getMarketingPreference
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getMarketingPreference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the marketing subscription is SUBSCRIBED', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        subscriptionStatuses: [
          { id: 2233676376, status: 'SUBSCRIBED' },
          { id: 9999, status: 'UNSUBSCRIBED' },
        ],
      }),
    );

    await expect(getMarketingPreference('user@example.com')).resolves.toBe(true);

    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${STATUSES_BASE}user%40example.com?channel=EMAIL`);
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer test-service-key' },
    });
  });

  it('returns false when the marketing subscription is UNSUBSCRIBED', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        subscriptionStatuses: [{ id: 2233676376, status: 'UNSUBSCRIBED' }],
      }),
    );

    await expect(getMarketingPreference('user@example.com')).resolves.toBe(false);
  });

  it('returns false when the marketing subscription record is missing', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        subscriptionStatuses: [{ id: 9999, status: 'SUBSCRIBED' }],
      }),
    );

    await expect(getMarketingPreference('user@example.com')).resolves.toBe(false);
  });

  it('returns false on HTTP 404 (no contact / no preference record)', async () => {
    mockFetch.mockResolvedValueOnce(fail(404, 'not found'));

    await expect(getMarketingPreference('user@example.com')).resolves.toBe(false);
  });

  it('throws on non-404 non-2xx responses', async () => {
    mockFetch.mockResolvedValueOnce(fail(500, 'boom'));

    await expect(getMarketingPreference('user@example.com')).rejects.toThrow(
      /HubSpot get preferences failed \(500\): boom/,
    );
  });
});

// ---------------------------------------------------------------------------
// upsertContactSubscriptionStatus
// ---------------------------------------------------------------------------

const CONTACTS_BASE = 'https://api.hubapi.com/crm/v3/objects/contacts';

function jsonOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('upsertContactSubscriptionStatus', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('addresses the contact by filone_user_id, never by email', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({}));

    const outcome = await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Paying,
      email: 'someone@example.com',
    });

    expect(outcome).toBe('updated');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${CONTACTS_BASE}/user-123?idProperty=filone_user_id`);
    expect(init?.method).toBe('PATCH');
    // The email was available, yet the steady-state write does not carry it.
    expect(init?.body as string).not.toContain('someone@example.com');

    const body = JSON.parse(init?.body as string);
    expect(body.properties.filone_subscription_status).toBe('paying');
    expect(body.properties.filone_subscription_status_updated).toEqual(expect.any(String));
  });

  it('url-encodes the user id', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({}));

    await upsertContactSubscriptionStatus({
      userId: 'auth0|abc/def',
      status: HubSpotLifecycleStatus.Trialing,
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      `${CONTACTS_BASE}/auth0%7Cabc%2Fdef?idProperty=filone_user_id`,
    );
  });

  it('bootstraps by email when no contact carries the id yet', async () => {
    mockFetch
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(jsonOk({ results: [{ id: '501' }] }));

    const outcome = await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Lapsed,
      email: 'someone@example.com',
    });

    expect(outcome).toBe('bootstrapped');

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe(`${CONTACTS_BASE}/batch/upsert`);
    const body = JSON.parse(init?.body as string);
    expect(body.inputs[0].idProperty).toBe('email');
    expect(body.inputs[0].id).toBe('someone@example.com');
    // The id is stamped in the same call, so the next write skips this path.
    expect(body.inputs[0].properties.filone_user_id).toBe('user-123');
    expect(body.inputs[0].properties.filone_subscription_status).toBe('lapsed');
  });

  it('reports unmatched when the id is unknown and no email is available', async () => {
    mockFetch.mockResolvedValueOnce(fail(404));

    const outcome = await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Paying,
    });

    expect(outcome).toBe('unmatched');
    // No bootstrap attempt without an email to match on.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports unmatched when the email matches no contact', async () => {
    mockFetch.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(jsonOk({ results: [] }));

    const outcome = await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Paying,
      email: 'stale@example.com',
    });

    expect(outcome).toBe('unmatched');
  });

  it('retries a 429 and succeeds', async () => {
    mockFetch.mockResolvedValueOnce(fail(429, 'rate limited')).mockResolvedValueOnce(jsonOk({}));

    const outcome = await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Paying,
    });

    expect(outcome).toBe('updated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 — a missing property will never succeed', async () => {
    mockFetch.mockResolvedValue(fail(400, 'Property "filone_user_id" does not exist'));

    await expect(
      upsertContactSubscriptionStatus({
        userId: 'user-123',
        status: HubSpotLifecycleStatus.Paying,
      }),
    ).rejects.toThrow(/contact status update failed \(400\)/);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends the bearer token', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({}));

    await upsertContactSubscriptionStatus({
      userId: 'user-123',
      status: HubSpotLifecycleStatus.Paying,
    });

    expect(mockFetch.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer test-service-key' }),
    });
  });
});

// ---------------------------------------------------------------------------
// getContactSubscriptionStatus
// ---------------------------------------------------------------------------

describe('getContactSubscriptionStatus', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns the stored status', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonOk({ id: '501', properties: { filone_subscription_status: 'paying' } }),
    );

    await expect(getContactSubscriptionStatus('user-123')).resolves.toBe('paying');
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${CONTACTS_BASE}/user-123?idProperty=filone_user_id&properties=filone_subscription_status`,
    );
  });

  it('returns null when no contact carries the id', async () => {
    mockFetch.mockResolvedValueOnce(fail(404));
    await expect(getContactSubscriptionStatus('user-123')).resolves.toBeNull();
  });

  it('returns null when the contact exists but the property is unset', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ id: '501', properties: {} }));
    await expect(getContactSubscriptionStatus('user-123')).resolves.toBeNull();
  });
});
