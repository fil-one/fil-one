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
process.env.AUTH_CALLBACK_URL = 'https://api.test.com/auth/callback';

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

  describe('when token exchange fails', () => {
    it('redirects to sign-in with a token exchange error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

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

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => tokenResponse,
      });
    });

    it('redirects to /dashboard', async () => {
      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

      const result = await handler(event, stubContext);

      expect(result.statusCode).toBe(302);
      expect(result.headers!['Location']).toBe('https://app.example.com/dashboard');
    });

    it('sends the correct token request to Auth0', async () => {
      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

      await handler(event, stubContext);

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
      expect(body.get('redirect_uri')).toBe('https://api.test.com/auth/callback');
      expect(body.get('audience')).toBe('https://api.test.com');
    });

    it('sets access, id, refresh, and logged_in cookies', async () => {
      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

      const result = await handler(event, stubContext);

      expect(result.cookies).toHaveLength(4);
      expect(result.cookies![0]).toContain('hs_access_token=new-access-token');
      expect(result.cookies![1]).toContain('hs_id_token=new-id-token');
      expect(result.cookies![2]).toContain('hs_refresh_token=new-refresh-token');
      expect(result.cookies![3]).toContain('hs_logged_in=1');
    });

    it('omits refresh_token cookie when Auth0 does not return one', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at',
          id_token: 'it',
        }),
      });

      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

      const result = await handler(event, stubContext);

      expect(result.cookies).toHaveLength(3);
      expect(result.cookies![0]).toContain('hs_access_token=at');
      expect(result.cookies![1]).toContain('hs_id_token=it');
      expect(result.cookies![2]).toContain('hs_logged_in=1');
    });

    it('sets HttpOnly on token cookies but not on logged_in hint cookie', async () => {
      const event = buildEvent({ queryStringParameters: { code: 'auth-code-123' } });

      const result = await handler(event, stubContext);

      expect(result.cookies![0]).toContain('HttpOnly');
      expect(result.cookies![1]).toContain('HttpOnly');
      expect(result.cookies![2]).toContain('HttpOnly');
      expect(result.cookies![3]).not.toContain('HttpOnly');
    });
  });
});
