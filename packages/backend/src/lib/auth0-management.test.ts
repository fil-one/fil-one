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

process.env.AUTH0_DOMAIN = 'test.auth0.com';

import {
  flagMfaEnrollment,
  getMfaEnrollments,
  deleteGuardianEnrollment,
  deleteAuthenticationMethod,
  deleteAllAuthenticators,
  getConnectionType,
  MFA_GUARDIAN_TYPES,
} from './auth0-management.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTokenResponse() {
  return new Response(JSON.stringify({ access_token: 'mgmt-token' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFetchMock(responses: Array<{ match: string; response: Response }>) {
  mockFetch.mockImplementation(async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes('/oauth/token')) return mockTokenResponse();
    for (const { match, response } of responses) {
      if (urlStr.includes(match)) return response;
    }
    return new Response('Not found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// getConnectionType
// ---------------------------------------------------------------------------

describe('getConnectionType', () => {
  it('extracts auth0 from sub', () => {
    expect(getConnectionType('auth0|abc123')).toBe('auth0');
  });

  it('extracts google-oauth2 from sub', () => {
    expect(getConnectionType('google-oauth2|123')).toBe('google-oauth2');
  });

  it('returns unknown for sub without pipe', () => {
    expect(getConnectionType('nopipe')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// MFA_GUARDIAN_TYPES
// ---------------------------------------------------------------------------

describe('MFA_GUARDIAN_TYPES', () => {
  it('includes authenticator, webauthn-roaming, webauthn-platform', () => {
    expect(MFA_GUARDIAN_TYPES.has('authenticator')).toBe(true);
    expect(MFA_GUARDIAN_TYPES.has('webauthn-roaming')).toBe(true);
    expect(MFA_GUARDIAN_TYPES.has('webauthn-platform')).toBe(true);
  });

  it('excludes email and other types', () => {
    expect(MFA_GUARDIAN_TYPES.has('email')).toBe(false);
    expect(MFA_GUARDIAN_TYPES.has('sms')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// flagMfaEnrollment
// ---------------------------------------------------------------------------

describe('flagMfaEnrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls PATCH with mfa_enrolling: true in app_metadata', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return mockTokenResponse();
      if (String(url).includes('/api/v2/users/') && init?.method === 'PATCH') {
        capturedBody = JSON.parse(init.body as string);
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    await flagMfaEnrollment('auth0|abc123');

    expect(capturedBody).toEqual({
      app_metadata: { mfa_enrolling: true },
    });
  });
});

// ---------------------------------------------------------------------------
// getMfaEnrollments
// ---------------------------------------------------------------------------

describe('getMfaEnrollments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns TOTP and WebAuthn from /authentication-methods, excluding email entries', async () => {
    // Repro for the original bug: a user with both TOTP and WebAuthn enrolled
    // had only one of them visible in Settings because the older code only
    // pulled OTP from Guardian and ignored TOTP in /authentication-methods.
    // Email entries (which Auth0 may attach automatically) must never surface.
    setupFetchMock([
      {
        match: '/authentication-methods',
        response: new Response(
          JSON.stringify([
            {
              id: 'totp|am-1',
              type: 'totp',
              confirmed: true,
              created_at: '2026-04-03T00:00:00.000Z',
            },
            {
              id: 'webauthn|am-3',
              type: 'webauthn-roaming',
              name: 'My key',
              confirmed: true,
              created_at: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'email|am-1',
              type: 'email',
              confirmed: true,
              created_at: '2026-04-01T00:00:00.000Z',
            },
          ]),
          { status: 200 },
        ),
      },
      {
        match: '/enrollments',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
    ]);

    const result = await getMfaEnrollments('auth0|abc123');

    expect(result).toEqual([
      {
        id: 'totp|am-1',
        type: 'authenticator',
        status: 'confirmed',
        name: undefined,
        enrolled_at: '2026-04-03T00:00:00.000Z',
        source: 'auth-methods',
      },
      {
        id: 'webauthn|am-3',
        type: 'webauthn-roaming',
        status: 'confirmed',
        name: 'My key',
        enrolled_at: '2026-04-02T00:00:00.000Z',
        source: 'auth-methods',
      },
    ]);
  });

  it('falls back to Guardian for TOTP when /authentication-methods has no totp entry (legacy users)', async () => {
    setupFetchMock([
      {
        match: '/authentication-methods',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
      {
        match: '/enrollments',
        response: new Response(
          JSON.stringify([
            { id: 'otp|1', type: 'authenticator', status: 'confirmed', name: 'My OTP' },
            { id: 'otp|4', type: 'authenticator', status: 'unconfirmed' },
          ]),
          { status: 200 },
        ),
      },
    ]);

    const result = await getMfaEnrollments('auth0|abc123');

    expect(result).toEqual([
      {
        id: 'otp|1',
        type: 'authenticator',
        status: 'confirmed',
        name: 'My OTP',
        source: 'guardian',
      },
    ]);
  });

  it('returns empty array when no MFA enrollments exist', async () => {
    setupFetchMock([
      {
        match: '/enrollments',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
      {
        match: '/authentication-methods',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
    ]);

    const result = await getMfaEnrollments('auth0|abc123');

    expect(result).toEqual([]);
  });

  it('throws on enrollments API error', async () => {
    setupFetchMock([
      {
        match: '/enrollments',
        response: new Response('Forbidden', { status: 403 }),
      },
      {
        match: '/authentication-methods',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
    ]);

    await expect(getMfaEnrollments('auth0|abc123')).rejects.toThrow(
      'Auth0 list enrollments failed (403): Forbidden',
    );
  });

  it('throws on authentication-methods API error', async () => {
    setupFetchMock([
      {
        match: '/authentication-methods',
        response: new Response('Forbidden', { status: 403 }),
      },
      {
        match: '/enrollments',
        response: new Response(JSON.stringify([]), { status: 200 }),
      },
    ]);

    await expect(getMfaEnrollments('auth0|abc123')).rejects.toThrow(
      'Auth0 list authentication methods failed (403): Forbidden',
    );
  });
});

// ---------------------------------------------------------------------------
// deleteGuardianEnrollment
// ---------------------------------------------------------------------------

describe('deleteGuardianEnrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls DELETE on the guardian enrollments endpoint', async () => {
    let deletedUrl: string | undefined;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return mockTokenResponse();
      if (String(url).includes('/guardian/enrollments/') && init?.method === 'DELETE') {
        deletedUrl = String(url);
        return new Response('', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    await deleteGuardianEnrollment('webauthn-roaming|dev_abc');

    expect(deletedUrl).toContain(
      `/api/v2/guardian/enrollments/${encodeURIComponent('webauthn-roaming|dev_abc')}`,
    );
  });

  it('throws on API error', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return mockTokenResponse();
      if (init?.method === 'DELETE') {
        return new Response('Not found', { status: 404 });
      }
      return new Response('Not found', { status: 404 });
    });

    await expect(deleteGuardianEnrollment('nonexistent')).rejects.toThrow(
      'Auth0 delete enrollment failed (404): Not found',
    );
  });
});

// ---------------------------------------------------------------------------
// deleteAuthenticationMethod
// ---------------------------------------------------------------------------

describe('deleteAuthenticationMethod', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls DELETE on the authentication-methods endpoint', async () => {
    let deletedUrl: string | undefined;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return mockTokenResponse();
      if (String(url).includes('/authentication-methods/') && init?.method === 'DELETE') {
        deletedUrl = String(url);
        return new Response(null, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    await deleteAuthenticationMethod('auth0|abc123', 'email|dev_abc');

    expect(deletedUrl).toContain(
      `/api/v2/users/${encodeURIComponent('auth0|abc123')}/authentication-methods/${encodeURIComponent('email|dev_abc')}`,
    );
  });

  it('throws on API error', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return mockTokenResponse();
      if (init?.method === 'DELETE') {
        return new Response('Not found', { status: 404 });
      }
      return new Response('Not found', { status: 404 });
    });

    await expect(deleteAuthenticationMethod('auth0|abc123', 'nonexistent')).rejects.toThrow(
      'Auth0 delete authentication method failed (404): Not found',
    );
  });
});

// ---------------------------------------------------------------------------
// deleteAllAuthenticators
// ---------------------------------------------------------------------------

describe('deleteAllAuthenticators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes Guardian (OTP) and authentication-method (WebAuthn) factors then clears mfa_enrolling flag', async () => {
    const guardianDeletedIds: string[] = [];
    const authMethodDeletedUrls: string[] = [];
    let patchBody: Record<string, unknown> | undefined;

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/oauth/token')) return mockTokenResponse();
      if (urlStr.endsWith('/authentication-methods') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([{ id: 'webauthn|2', type: 'webauthn-roaming', confirmed: true }]),
          { status: 200 },
        );
      }
      if (urlStr.includes('/enrollments') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([{ id: 'otp|1', type: 'authenticator', status: 'confirmed' }]),
          { status: 200 },
        );
      }
      if (urlStr.includes('/guardian/enrollments/') && init?.method === 'DELETE') {
        const id = urlStr.split('/guardian/enrollments/')[1];
        guardianDeletedIds.push(id);
        return new Response('', { status: 200 });
      }
      if (urlStr.includes('/authentication-methods/') && init?.method === 'DELETE') {
        authMethodDeletedUrls.push(urlStr);
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes('/api/v2/users/') && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body as string);
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    await deleteAllAuthenticators('auth0|abc123');

    expect(guardianDeletedIds).toEqual([encodeURIComponent('otp|1')]);
    expect(authMethodDeletedUrls).toHaveLength(1);
    expect(authMethodDeletedUrls.some((u) => u.includes(encodeURIComponent('webauthn|2')))).toBe(
      true,
    );
    expect(patchBody).toEqual({
      app_metadata: { mfa_enrolling: false },
    });
  });

  it('does not clear mfa_enrolling when a delete fails (partial failure)', async () => {
    let patchBody: Record<string, unknown> | undefined;

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/oauth/token')) return mockTokenResponse();
      if (urlStr.endsWith('/authentication-methods') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([{ id: 'webauthn|2', type: 'webauthn-roaming', confirmed: true }]),
          { status: 200 },
        );
      }
      if (urlStr.includes('/enrollments') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([{ id: 'otp|1', type: 'authenticator', status: 'confirmed' }]),
          { status: 200 },
        );
      }
      if (
        urlStr.includes(`/guardian/enrollments/${encodeURIComponent('otp|1')}`) &&
        init?.method === 'DELETE'
      ) {
        return new Response('', { status: 200 });
      }
      if (
        urlStr.includes(`/authentication-methods/${encodeURIComponent('webauthn|2')}`) &&
        init?.method === 'DELETE'
      ) {
        return new Response('boom', { status: 500 });
      }
      if (urlStr.includes('/api/v2/users/') && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body as string);
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    await expect(deleteAllAuthenticators('auth0|abc123')).rejects.toThrow(
      /Failed to delete 1 of 2 MFA factor/,
    );
    // Critical: leaving the flag set means the Post-Login Action keeps
    // protecting the user with whatever factors remain.
    expect(patchBody).toBeUndefined();
  });

  it('attempts every delete even when one fails', async () => {
    const guardianAttempts: string[] = [];
    const authMethodAttempts: string[] = [];

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/oauth/token')) return mockTokenResponse();
      if (urlStr.endsWith('/authentication-methods') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([{ id: 'webauthn|2', type: 'webauthn-roaming', confirmed: true }]),
          { status: 200 },
        );
      }
      if (urlStr.includes('/enrollments') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            { id: 'otp|1', type: 'authenticator', status: 'confirmed' },
            { id: 'otp|3', type: 'authenticator', status: 'confirmed' },
          ]),
          { status: 200 },
        );
      }
      if (urlStr.includes('/guardian/enrollments/') && init?.method === 'DELETE') {
        const id = urlStr.split('/guardian/enrollments/')[1];
        guardianAttempts.push(id);
        return new Response('', { status: 200 });
      }
      if (urlStr.includes('/authentication-methods/') && init?.method === 'DELETE') {
        const id = urlStr.split('/authentication-methods/')[1];
        authMethodAttempts.push(id);
        return new Response('boom', { status: 500 });
      }
      return new Response('Not found', { status: 404 });
    });

    await expect(deleteAllAuthenticators('auth0|abc123')).rejects.toThrow();

    // All three were attempted — Promise.allSettled does not bail on first failure.
    expect(guardianAttempts).toHaveLength(2);
    expect(guardianAttempts).toEqual(
      expect.arrayContaining([encodeURIComponent('otp|1'), encodeURIComponent('otp|3')]),
    );
    expect(authMethodAttempts).toEqual([encodeURIComponent('webauthn|2')]);
  });
});

// ---------------------------------------------------------------------------
// Domain resolution
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
