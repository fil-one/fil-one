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
  getMarketingPreference,
  updateSubscriptionStatus,
} from './hubspot-client.js';

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

  it('falls back to the boolean `subscribed` field when present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        subscriptionStatuses: [{ id: 2233676376, subscribed: true }],
      }),
    );

    await expect(getMarketingPreference('user@example.com')).resolves.toBe(true);
  });

  it('throws on non-404 non-2xx responses', async () => {
    mockFetch.mockResolvedValueOnce(fail(500, 'boom'));

    await expect(getMarketingPreference('user@example.com')).rejects.toThrow(
      /HubSpot get preferences failed \(500\): boom/,
    );
  });
});
