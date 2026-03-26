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

const mockRandomUUID = vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
vi.stubGlobal('crypto', { randomUUID: mockRandomUUID });

process.env.WEBSITE_URL = 'https://app.example.com';
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.ALLOWED_REDIRECT_ORIGINS = '';

import { handler } from './auth-login.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubContext = buildContext({ functionName: 'auth-login' });

function parseLocation(result: { headers?: Record<string, string | number | boolean> }): URL {
  return new URL(String(result.headers!['Location']));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth-login handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    process.env.ALLOWED_REDIRECT_ORIGINS = '';
  });

  // -------------------------------------------------------------------------
  // Basic redirect
  // -------------------------------------------------------------------------

  it('returns a 302 redirect to Auth0 authorize endpoint', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);

    expect(result.statusCode).toBe(302);
    const location = parseLocation(result);
    expect(location.origin).toBe('https://test.auth0.com');
    expect(location.pathname).toBe('/authorize');
  });

  it('includes all required OAuth parameters', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);

    const params = parseLocation(result).searchParams;
    expect(params.get('client_id')).toBe('test-client-id');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/api/auth/callback');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('audience')).toBe('https://api.test.com');
    expect(params.get('state')).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  // -------------------------------------------------------------------------
  // State cookie
  // -------------------------------------------------------------------------

  it('sets the OAuth state cookie with correct attributes', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);
    const cookies = result.cookies ?? [];

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toBe(
      'hs_oauth_state=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
    );
  });

  it('uses the same state value in the cookie and the authorize URL', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);

    const cookies = result.cookies ?? [];
    const cookieState = cookies[0].split('=')[1].split(';')[0];
    const urlState = parseLocation(result).searchParams.get('state');
    expect(cookieState).toBe(urlState);
  });

  // -------------------------------------------------------------------------
  // screen_hint query parameter
  // -------------------------------------------------------------------------

  it('includes screen_hint=signup when query param is "signup"', async () => {
    const event = buildEvent({
      queryStringParameters: { screen_hint: 'signup' },
    });

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.get('screen_hint')).toBe('signup');
  });

  it('omits screen_hint when query param is not "signup"', async () => {
    const event = buildEvent({
      queryStringParameters: { screen_hint: 'login' },
    });

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.has('screen_hint')).toBe(false);
  });

  it('omits screen_hint when query param is absent', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.has('screen_hint')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // connection query parameter
  // -------------------------------------------------------------------------

  it('includes connection when query param is provided', async () => {
    const event = buildEvent({
      queryStringParameters: { connection: 'google-oauth2' },
    });

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.get('connection')).toBe('google-oauth2');
  });

  it('omits connection when query param is empty string', async () => {
    const event = buildEvent({
      queryStringParameters: { connection: '' },
    });

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.has('connection')).toBe(false);
  });

  it('omits connection when query param is absent', async () => {
    const event = buildEvent();

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.has('connection')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Combined query parameters
  // -------------------------------------------------------------------------

  it('passes both screen_hint and connection together', async () => {
    const event = buildEvent({
      queryStringParameters: { screen_hint: 'signup', connection: 'github' },
    });

    const result = await handler(event, stubContext);

    const params = parseLocation(result).searchParams;
    expect(params.get('screen_hint')).toBe('signup');
    expect(params.get('connection')).toBe('github');
  });

  // -------------------------------------------------------------------------
  // Origin resolution
  // -------------------------------------------------------------------------

  it('uses X-Dev-Origin when it matches ALLOWED_REDIRECT_ORIGINS', async () => {
    process.env.ALLOWED_REDIRECT_ORIGINS = 'https://localhost:5173';
    const event = buildEvent();
    event.headers['x-dev-origin'] = 'https://localhost:5173';

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.get('redirect_uri')).toBe(
      'https://localhost:5173/api/auth/callback',
    );
  });

  it('ignores X-Dev-Origin when not in ALLOWED_REDIRECT_ORIGINS', async () => {
    process.env.ALLOWED_REDIRECT_ORIGINS = '';
    const event = buildEvent();
    event.headers['x-dev-origin'] = 'https://evil.com';

    const result = await handler(event, stubContext);

    expect(parseLocation(result).searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/auth/callback',
    );
  });

  // -------------------------------------------------------------------------
  // No query parameters at all
  // -------------------------------------------------------------------------

  it('handles missing queryStringParameters gracefully', async () => {
    const event = buildEvent();
    delete (event as unknown as Record<string, unknown>).queryStringParameters;

    const result = await handler(event, stubContext);

    expect(result.statusCode).toBe(302);
    const params = parseLocation(result).searchParams;
    expect(params.has('screen_hint')).toBe(false);
    expect(params.has('connection')).toBe(false);
  });
});
