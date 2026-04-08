import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

export const COOKIE_NAMES = {
  ACCESS_TOKEN: 'hs_access_token',
  ID_TOKEN: 'hs_id_token',
  REFRESH_TOKEN: 'hs_refresh_token',
  LOGGED_IN: 'hs_logged_in',
} as const;

export const TOKEN_MAX_AGE = {
  ACCESS: 60 * 60, // 1 hour
  REFRESH: 30 * 24 * 60 * 60, // 30 days
} as const;

export function makeCookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAge}`;
}

/** Like makeCookieHeader but omits HttpOnly so the value is readable by JS. */
export function makeHintCookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Sets Max-Age=0 to delete a cookie. */
export function makeClearCookieHeader(name: string): string {
  return `${name}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// CORS headers are injected by API Gateway for all responses based on the
// corsPreflight configuration in the CDK stack — no need to set them here.
export class ResponseBuilder {
  private _statusCode = 200;
  private _body: object = {};
  private _cookies: string[] = [];

  status(code: number): this {
    this._statusCode = code;
    return this;
  }

  body<T extends object>(b: T): this {
    this._body = b;
    return this;
  }

  addCookie(cookie: string): this {
    this._cookies.push(cookie);
    return this;
  }

  build(): APIGatewayProxyStructuredResultV2 {
    return {
      statusCode: this._statusCode,
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
      },
      body: JSON.stringify(this._body),
      ...(this._cookies.length > 0 && { cookies: this._cookies }),
    };
  }
}
