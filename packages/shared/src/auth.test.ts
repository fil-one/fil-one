import { describe, it, expect } from 'vitest';
import { buildAuth0AuthorizeUrl } from './auth.ts';
import type { Auth0LoginUrlOptions } from './auth.ts';

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

  it('carries max_age when the caller asks for one, including zero', () => {
    // A step-up sends `max_age=0`; dropped as falsy it would silently become an
    // ordinary login that reuses the existing Auth0 session.
    expect(
      parseUrl(buildAuth0AuthorizeUrl({ ...baseOptions, maxAge: 0 })).searchParams.get('max_age'),
    ).toBe('0');
    expect(
      parseUrl(buildAuth0AuthorizeUrl({ ...baseOptions, maxAge: 300 })).searchParams.get('max_age'),
    ).toBe('300');
  });

  it('omits max_age and organization when neither is given', () => {
    const params = parseUrl(buildAuth0AuthorizeUrl(baseOptions)).searchParams;

    expect(params.has('max_age')).toBe(false);
    expect(params.has('organization')).toBe(false);
  });

  it('carries the reserved organization parameter when one is given', () => {
    // Nothing sends it in M1. It is plumbed so that a step-up round trip is
    // never the place org context silently drops.
    const url = buildAuth0AuthorizeUrl({ ...baseOptions, organization: 'org_abc123' });

    expect(parseUrl(url).searchParams.get('organization')).toBe('org_abc123');
  });
});
