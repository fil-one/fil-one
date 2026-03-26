import { describe, it, expect } from 'vitest';
import { buildAuth0AuthorizeUrl } from './auth.js';
import type { Auth0LoginUrlOptions } from './auth.js';

const baseOptions: Auth0LoginUrlOptions = {
  domain: 'test.auth0.com',
  clientId: 'client-123',
  audience: 'https://api.test.com',
  redirectUri: 'https://app.example.com/api/auth/callback',
  state: 'state-abc',
};

function parseUrl(url: string): URL {
  return new URL(url);
}

describe('buildAuth0AuthorizeUrl', () => {
  it('returns a URL targeting the Auth0 authorize endpoint', () => {
    const url = parseUrl(buildAuth0AuthorizeUrl(baseOptions));

    expect(url.origin).toBe('https://test.auth0.com');
    expect(url.pathname).toBe('/authorize');
  });

  it('includes all required OAuth parameters', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl(baseOptions)).searchParams;

    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/api/auth/callback');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('audience')).toBe('https://api.test.com');
    expect(params.get('state')).toBe('state-abc');
  });

  it('includes login_hint when provided', () => {
    const params = parseUrl(
      buildAuth0AuthorizeUrl({ ...baseOptions, loginHint: 'user@example.com' }),
    ).searchParams;

    expect(params.get('login_hint')).toBe('user@example.com');
  });

  it('omits login_hint when not provided', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl(baseOptions)).searchParams;

    expect(params.has('login_hint')).toBe(false);
  });

  it('omits login_hint when empty string', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl({ ...baseOptions, loginHint: '' })).searchParams;

    expect(params.has('login_hint')).toBe(false);
  });

  it('includes screen_hint when provided', () => {
    const params = parseUrl(
      buildAuth0AuthorizeUrl({ ...baseOptions, screenHint: 'signup' }),
    ).searchParams;

    expect(params.get('screen_hint')).toBe('signup');
  });

  it('omits screen_hint when not provided', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl(baseOptions)).searchParams;

    expect(params.has('screen_hint')).toBe(false);
  });

  it('includes connection when provided', () => {
    const params = parseUrl(
      buildAuth0AuthorizeUrl({ ...baseOptions, connection: 'google-oauth2' }),
    ).searchParams;

    expect(params.get('connection')).toBe('google-oauth2');
  });

  it('omits connection when not provided', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl(baseOptions)).searchParams;

    expect(params.has('connection')).toBe(false);
  });

  it('omits connection when empty string', () => {
    const params = parseUrl(
      buildAuth0AuthorizeUrl({ ...baseOptions, connection: '' }),
    ).searchParams;

    expect(params.has('connection')).toBe(false);
  });

  it('includes all optional parameters together', () => {
    const params = parseUrl(
      buildAuth0AuthorizeUrl({
        ...baseOptions,
        loginHint: 'user@example.com',
        screenHint: 'signup',
        connection: 'github',
      }),
    ).searchParams;

    expect(params.get('login_hint')).toBe('user@example.com');
    expect(params.get('screen_hint')).toBe('signup');
    expect(params.get('connection')).toBe('github');
  });

  it('properly encodes special characters in parameters', () => {
    const url = buildAuth0AuthorizeUrl({
      ...baseOptions,
      audience: 'https://api.test.com/v1',
      loginHint: 'user+tag@example.com',
    });
    const params = parseUrl(url).searchParams;

    expect(params.get('audience')).toBe('https://api.test.com/v1');
    expect(params.get('login_hint')).toBe('user+tag@example.com');
  });
});
