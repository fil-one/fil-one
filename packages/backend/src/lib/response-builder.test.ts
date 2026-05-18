import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  makeCookieHeader,
  makeHintCookieHeader,
  makeClearCookieHeader,
  ResponseBuilder,
  COOKIE_ATTRIBUTES,
} from './response-builder.js';

describe('makeCookieHeader', () => {
  it('returns correct format with HttpOnly, Secure, SameSite, Path, Max-Age', () => {
    const result = makeCookieHeader('test', 'value123', 3600);
    expect(result).toBe(`test=value123; ${COOKIE_ATTRIBUTES}; Max-Age=3600`);
    expect(result).toContain('HttpOnly');
    expect(result).toContain('Secure');
    expect(result).toContain('SameSite=Lax');
    expect(result).toContain('Path=/');
    expect(result).toContain('Max-Age=3600');
  });
});

describe('makeHintCookieHeader', () => {
  it('returns correct format without HttpOnly', () => {
    const result = makeHintCookieHeader('hint', '1', 86400);
    expect(result).not.toContain('HttpOnly');
    expect(result).toContain('Secure');
    expect(result).toContain('SameSite=Lax');
    expect(result).toContain('Path=/');
    expect(result).toContain('Max-Age=86400');
    expect(result).toBe('hint=1; Secure; SameSite=Lax; Path=/; Max-Age=86400');
  });
});

describe('makeClearCookieHeader', () => {
  it('sets Max-Age=0 to delete the cookie', () => {
    const result = makeClearCookieHeader('old_cookie');
    expect(result).toContain('Max-Age=0');
    expect(result).toBe('old_cookie=; Secure; SameSite=Lax; Path=/; Max-Age=0');
  });
});

describe('ResponseBuilder', () => {
  it('builds response with statusCode, JSON body, and security headers', () => {
    const result = new ResponseBuilder()
      .status(200)
      .body({ hello: 'world' })
      .build() as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ hello: 'world' });
    expect(result.headers).toBeDefined();
    const headers = result.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });

  it('includes cookies array when addCookie is called', () => {
    const result = new ResponseBuilder()
      .status(200)
      .body({})
      .addCookie('foo=bar; HttpOnly')
      .build() as APIGatewayProxyStructuredResultV2;

    expect(result.cookies).toEqual(['foo=bar; HttpOnly']);
  });

  it('omits cookies key when no cookies are added', () => {
    const result = new ResponseBuilder().status(200).body({}).build();
    expect(result).not.toHaveProperty('cookies');
  });

  it('supports chaining (status/body/addCookie return this)', () => {
    const builder = new ResponseBuilder();
    expect(builder.status(201)).toBe(builder);
    expect(builder.body({ ok: true })).toBe(builder);
    expect(builder.addCookie('a=b')).toBe(builder);
  });

  it('defaults to 200 status when not specified', () => {
    const result = new ResponseBuilder().body({}).build() as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(200);
  });
});
