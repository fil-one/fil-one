import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    Auth0ClientId: { value: 'test-client-id' },
    Auth0ClientSecret: { value: 'test-client-secret' },
  },
}));

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

process.env.WEBSITE_URL = 'https://app.example.com';
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.ALLOWED_REDIRECT_ORIGINS = '';

import { handler } from './auth-callback.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubContext = buildContext({ functionName: 'auth-callback' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth-callback handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Error / edge cases
  // -------------------------------------------------------------------------

  describe('when Auth0 returns an error', () => {
    it('redirects to sign-in with the error description', async () => {
      const event = buildEvent({
        queryStringParameters: { error: 'access_denied', error_description: 'User cancelled' },
      });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=User%20cancelled');
    });

    it('redirects to sign-in with the error code when no description', async () => {
      const event = buildEvent({
        queryStringParameters: { error: 'access_denied' },
      });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=access_denied');
    });
  });

  describe('when no code is present', () => {
    it('redirects to sign-in with a generic error', async () => {
      const event = buildEvent();

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=Authentication%20failed');
    });
  });

  // -------------------------------------------------------------------------
  // Token exchange failure
  // -------------------------------------------------------------------------

  describe('when OAuth state is invalid', () => {
    it('redirects to sign-in with an invalid state error', async () => {
      const event = buildEvent({
        queryStringParameters: { code: 'auth-code-123', state: 'wrong-state' },
        cookies: ['hs_oauth_state=correct-state'],
      });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=Invalid%20state');
    });

    it('redirects to sign-in when state cookie is missing', async () => {
      const event = buildEvent({
        queryStringParameters: { code: 'auth-code-123', state: 'some-state' },
      });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=Invalid%20state');
    });
  });

  describe('when token exchange fails', () => {
    it('redirects to sign-in with a token exchange error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const event = buildEvent({
        queryStringParameters: { code: 'auth-code-123', state: 'valid-state' },
        cookies: ['hs_oauth_state=valid-state'],
      });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/sign-in?error=Token%20exchange%20failed');
    });
  });

  // -------------------------------------------------------------------------
  // Successful token exchange
  // -------------------------------------------------------------------------

  describe('when token exchange succeeds', () => {
    const tokenResponse = {
      access_token: 'new-access-token',
      id_token: 'new-id-token',
      refresh_token: 'new-refresh-token',
    };

    const validStateEvent = (overrides?: Parameters<typeof buildEvent>[0]) =>
      buildEvent({
        queryStringParameters: { code: 'auth-code-123', state: 'valid-state' },
        cookies: ['hs_oauth_state=valid-state'],
        ...overrides,
      });

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => tokenResponse,
      });
    });

    it('redirects to /dashboard', async () => {
      const result = await handler(validStateEvent(), stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/dashboard');
    });

    it('sends the correct token request to Auth0', async () => {
      await handler(validStateEvent(), stubContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.auth0.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
      expect(body.get('code')).toBe('auth-code-123');
      expect(body.get('redirect_uri')).toBe('https://app.example.com/api/auth/callback');
      expect(body.get('audience')).toBe('https://api.test.com');
    });

    it('sets auth cookies, CSRF cookie, and clears state cookie', async () => {
      const result = await handler(validStateEvent(), stubContext);
      const cookies = result.cookies ?? [];

      expect(cookies).toHaveLength(6);
      expect(cookies[0]).toBe('hs_access_token=new-access-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[1]).toBe('hs_id_token=new-id-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[2]).toBe('hs_refresh_token=new-refresh-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[3]).toBe('hs_logged_in=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[4]).toMatch(/^hs_csrf_token=[a-f0-9-]+; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/);
      expect(cookies[5]).toBe('hs_oauth_state=; Secure; SameSite=Lax; Path=/; Max-Age=0');
    });

    it('uses X-Dev-Origin when it matches ALLOWED_REDIRECT_ORIGINS', async () => {
      process.env.ALLOWED_REDIRECT_ORIGINS = 'https://localhost:5173';
      const event = validStateEvent();
      event.headers['x-dev-origin'] = 'https://localhost:5173';

      const result = await handler(event, stubContext);

      expect(result.headers?.['Location']).toBe('https://localhost:5173/dashboard');
      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('redirect_uri')).toBe('https://localhost:5173/api/auth/callback');

      // Reset
      process.env.ALLOWED_REDIRECT_ORIGINS = '';
    });

    it('ignores X-Dev-Origin when not in ALLOWED_REDIRECT_ORIGINS', async () => {
      process.env.ALLOWED_REDIRECT_ORIGINS = '';
      const event = validStateEvent();
      event.headers['x-dev-origin'] = 'https://evil.com';

      const result = await handler(event, stubContext);

      expect(result.headers!['Location']).toBe('https://app.example.com/dashboard');
    });

    it('omits refresh_token cookie when Auth0 does not return one', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at',
          id_token: 'it',
        }),
      });

      const result = await handler(validStateEvent(), stubContext);
      const cookies = result.cookies ?? [];

      expect(cookies).toHaveLength(5);
      expect(cookies[0]).toBe('hs_access_token=at; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[1]).toBe('hs_id_token=it; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      expect(cookies[2]).toBe('hs_logged_in=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      expect(cookies[3]).toMatch(/^hs_csrf_token=[a-f0-9-]+; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/);
      expect(cookies[4]).toBe('hs_oauth_state=; Secure; SameSite=Lax; Path=/; Max-Age=0');
    });
  });
});
