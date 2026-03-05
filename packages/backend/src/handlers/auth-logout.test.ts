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
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(location.searchParams.get('returnTo')).toBe('https://app.example.com/sign-in');
  });

  it('clears all four auth cookies', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);

    expect(result.cookies).toHaveLength(4);
    expect(result.cookies![0]).toContain('hs_access_token=');
    expect(result.cookies![0]).toContain('Max-Age=0');
    expect(result.cookies![1]).toContain('hs_id_token=');
    expect(result.cookies![1]).toContain('Max-Age=0');
    expect(result.cookies![2]).toContain('hs_refresh_token=');
    expect(result.cookies![2]).toContain('Max-Age=0');
    expect(result.cookies![3]).toContain('hs_logged_in=');
    expect(result.cookies![3]).toContain('Max-Age=0');
  });

  it('returns an empty body', async () => {
    const event = buildEvent();
    const result = await handler(event, stubContext);

    expect(result.body).toBe('');
  });
});
