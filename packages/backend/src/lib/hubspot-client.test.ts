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

import { syncMarketingPreference } from './hubspot-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UPSERT_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';
const STATUSES_BASE = 'https://api.hubapi.com/communication-preferences/2026-03/statuses/';

function ok(status = 200) {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
}

function fail(status: number, body = 'boom') {
  return new Response(body, { status });
}

function callsByUrl(prefix: string) {
  return mockFetch.mock.calls.filter(([url]) => String(url).startsWith(prefix));
}

// ---------------------------------------------------------------------------
// syncMarketingPreference
// ---------------------------------------------------------------------------

describe('syncMarketingPreference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts the contact then posts SUBSCRIBED on opt-in', async () => {
    mockFetch.mockResolvedValueOnce(ok(201)).mockResolvedValueOnce(ok(200));

    await syncMarketingPreference('user@example.com', true);

    const [upsertCall, statusCall] = mockFetch.mock.calls;

    expect(upsertCall[0]).toBe(UPSERT_URL);
    expect(upsertCall[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-service-key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(upsertCall[1]!.body as string)).toEqual({
      properties: { email: 'user@example.com' },
    });

    expect(statusCall[0]).toBe(`${STATUSES_BASE}user%40example.com`);
    expect(statusCall[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-service-key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(statusCall[1]!.body as string)).toEqual({
      subscriptionId: 2233676376,
      statusState: 'SUBSCRIBED',
      channel: 'EMAIL',
      legalBasis: 'LEGITIMATE_INTEREST_CLIENT',
      legalBasisExplanation: 'User toggled marketing email preference in account settings',
    });
  });

  it('sends UNSUBSCRIBED on opt-out', async () => {
    mockFetch.mockResolvedValueOnce(ok(201)).mockResolvedValueOnce(ok(200));

    await syncMarketingPreference('user@example.com', false);

    const [, statusCall] = mockFetch.mock.calls;
    expect(JSON.parse(statusCall[1]!.body as string).statusState).toBe('UNSUBSCRIBED');
  });

  it('treats 409 on contact upsert as success and still updates status', async () => {
    mockFetch.mockResolvedValueOnce(fail(409, 'already exists')).mockResolvedValueOnce(ok(200));

    await syncMarketingPreference('user@example.com', true);

    expect(callsByUrl(STATUSES_BASE)).toHaveLength(1);
  });

  it('throws and skips status update when upsert fails with non-409', async () => {
    mockFetch.mockResolvedValueOnce(fail(500, 'server error'));

    await expect(syncMarketingPreference('user@example.com', true)).rejects.toThrow(
      /HubSpot upsert contact failed \(500\): server error/,
    );
    expect(callsByUrl(STATUSES_BASE)).toHaveLength(0);
  });

  it('throws with "subscribe" wording when status update fails on opt-in', async () => {
    mockFetch.mockResolvedValueOnce(ok(201)).mockResolvedValueOnce(fail(403, 'scope missing'));

    await expect(syncMarketingPreference('user@example.com', true)).rejects.toThrow(
      /HubSpot subscribe failed \(403\): scope missing/,
    );
  });

  it('throws with "unsubscribe" wording when status update fails on opt-out', async () => {
    mockFetch.mockResolvedValueOnce(ok(201)).mockResolvedValueOnce(fail(400, 'bad'));

    await expect(syncMarketingPreference('user@example.com', false)).rejects.toThrow(
      /HubSpot unsubscribe failed \(400\): bad/,
    );
  });

  it('URL-encodes special characters in the email path segment', async () => {
    mockFetch.mockResolvedValueOnce(ok(201)).mockResolvedValueOnce(ok(200));

    await syncMarketingPreference('user+tag@example.com', true);

    const [, statusCall] = mockFetch.mock.calls;
    expect(statusCall[0]).toBe(`${STATUSES_BASE}user%2Btag%40example.com`);
  });
});
