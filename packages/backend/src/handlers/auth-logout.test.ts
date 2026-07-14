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

process.env.WEBSITE_URL = 'https://app.example.com';
process.env.AUTH0_DOMAIN = 'test.auth0.com';

import { handler } from './auth-logout.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubContext = buildContext({ functionName: 'auth-logout' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth-logout handler', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('returns a 302 redirect to the Auth0 logout endpoint', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);

    expect(result.statusCode).toBe(302);
    const location = result.headers!['Location'] as string;
    expect(location).toContain('https://test.auth0.com/v2/logout');
  });

  it('includes client_id and returnTo in the logout URL', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);

    const location = new URL(result.headers!['Location'] as string);
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('returnTo')).toBe('https://fil.one');
  });

  it('clears all auth and CSRF cookies', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);
    const cookies = result.cookies ?? [];

    expect(cookies).toStrictEqual([
      'hs_access_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_id_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_refresh_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_logged_in=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
  });

  it('returns an empty body', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);

    expect(result.body).toBe('');
  });

  it('revokes the refresh token at Auth0 before clearing cookies', async () => {
    const event = buildEvent({
      cookies: ['hs_refresh_token=test-refresh-token-value'],
    });
    await handler(event, stubContext);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test.auth0.com/oauth/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    const body = new URLSearchParams(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.get('client_id')).toBe('test-client-id');
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('token')).toBe('test-refresh-token-value');
  });

  it('does not call revoke when no refresh token cookie is present', async () => {
    const event = buildEvent();
    await handler(event, stubContext);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still completes logout when revocation fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));
    const event = buildEvent({
      cookies: ['hs_refresh_token=test-refresh-token-value'],
    });
    const result = await handler(event, stubContext);

    expect(result.statusCode).toBe(302);
    expect(result.cookies).toStrictEqual([
      'hs_access_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_id_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_refresh_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_logged_in=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'hs_csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
  });
});
