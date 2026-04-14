import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    Auth0MgmtRuntimeClientId: { value: 'mgmt-runtime-id' },
    Auth0MgmtRuntimeClientSecret: { value: 'mgmt-runtime-secret' },
    Auth0ClientId: { value: 'client-id' },
  },
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOM_DOMAIN = 'auth.custom-domain.com';
const CANONICAL_DOMAIN = 'tenant.us.auth0.com';

function stubFetchOk() {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
}

function fetchCallUrls(): string[] {
  return mockFetch.mock.calls.map(([url]) => url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth0-management domain resolution', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.AUTH0_DOMAIN = CUSTOM_DOMAIN;
    delete process.env.AUTH0_MGMT_DOMAIN;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('when AUTH0_MGMT_DOMAIN is set', () => {
    beforeEach(() => {
      process.env.AUTH0_MGMT_DOMAIN = CANONICAL_DOMAIN;
      stubFetchOk();
    });

    it('updateAuth0User sends token request and PATCH to AUTH0_MGMT_DOMAIN', async () => {
      const { updateAuth0User } = await import('./auth0-management.js');
      await updateAuth0User('auth0|123', { name: 'Test' });

      const urls = fetchCallUrls();
      expect(urls[0]).toBe(`https://${CANONICAL_DOMAIN}/oauth/token`);
      expect(urls[1]).toBe(`https://${CANONICAL_DOMAIN}/api/v2/users/auth0%7C123`);
    });

    it('updateAuth0User sends correct audience in token request body', async () => {
      const { updateAuth0User } = await import('./auth0-management.js');
      await updateAuth0User('auth0|123', { name: 'Test' });

      const tokenBody = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(tokenBody).toMatchObject({
        grant_type: 'client_credentials',
        client_id: 'mgmt-runtime-id',
        client_secret: 'mgmt-runtime-secret',
        audience: `https://${CANONICAL_DOMAIN}/api/v2/`,
      });
    });

    it('sendVerificationEmail sends requests to AUTH0_MGMT_DOMAIN', async () => {
      const { sendVerificationEmail } = await import('./auth0-management.js');
      await sendVerificationEmail('auth0|456');

      const urls = fetchCallUrls();
      expect(urls[0]).toBe(`https://${CANONICAL_DOMAIN}/oauth/token`);
      expect(urls[1]).toBe(`https://${CANONICAL_DOMAIN}/api/v2/jobs/verification-email`);
    });

    it('initiatePasswordReset sends request to AUTH0_DOMAIN, not AUTH0_MGMT_DOMAIN', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const { initiatePasswordReset } = await import('./auth0-management.js');
      await initiatePasswordReset('user@example.com', 'client-id');

      const urls = fetchCallUrls();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe(`https://${CUSTOM_DOMAIN}/dbconnections/change_password`);
    });
  });

  describe('when AUTH0_MGMT_DOMAIN is not set', () => {
    beforeEach(() => {
      stubFetchOk();
    });

    it('updateAuth0User falls back to AUTH0_DOMAIN', async () => {
      const { updateAuth0User } = await import('./auth0-management.js');
      await updateAuth0User('auth0|123', { name: 'Test' });

      const urls = fetchCallUrls();
      expect(urls[0]).toBe(`https://${CUSTOM_DOMAIN}/oauth/token`);
      expect(urls[1]).toBe(`https://${CUSTOM_DOMAIN}/api/v2/users/auth0%7C123`);
    });

    it('sendVerificationEmail falls back to AUTH0_DOMAIN', async () => {
      const { sendVerificationEmail } = await import('./auth0-management.js');
      await sendVerificationEmail('auth0|456');

      const urls = fetchCallUrls();
      expect(urls[0]).toBe(`https://${CUSTOM_DOMAIN}/oauth/token`);
      expect(urls[1]).toBe(`https://${CUSTOM_DOMAIN}/api/v2/jobs/verification-email`);
    });

    it('initiatePasswordReset uses AUTH0_DOMAIN', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const { initiatePasswordReset } = await import('./auth0-management.js');
      await initiatePasswordReset('user@example.com', 'client-id');

      expect(fetchCallUrls()[0]).toBe(`https://${CUSTOM_DOMAIN}/dbconnections/change_password`);
    });
  });
});
