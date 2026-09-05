import { ApiErrorCode, type AccessKeySummary, type ErrorResponse } from '@filone/shared';
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

/**
 * A file the browser saves, rather than JSON.
 *
 * Built outside {@link ResponseBuilder}, which hardcodes a JSON content type
 * and stringifies its body — the same reason the auth handlers build their 302s
 * by hand. The security headers are repeated rather than skipped: this response
 * carries customer data, and `nosniff` matters more here than on JSON, because
 * a downloaded file is the thing a browser is most willing to guess about.
 *
 * `Content-Disposition` names the file for anything that follows the header.
 * The console fetches this as a blob and names the download itself, since the
 * request has to carry the org header and cannot be a plain link.
 */
export function csvResponse(body: string, filename: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
    },
    body,
  };
}

export function unsupportedRegionResponse(region: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({ message: `Unsupported region "${region}"` })
    .build();
}

/**
 * 410 rather than 401: the session is not merely unauthenticated, it can never
 * be revived, so the client must stop retrying and clear its state.
 */
export function accountDeletedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(410)
    .body<ErrorResponse>({
      message: 'This account has been deleted.',
      code: ApiErrorCode.ACCOUNT_DELETED,
    })
    .build();
}

export function tenantNotReadyResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({
      message: 'We are still setting up the region for you. Please try again in a moment.',
    })
    .build();
}

/**
 * An error that also reports the keys a change revoked before it was refused.
 * The keys are gone whatever the transaction did, so a refusal that dropped
 * them would leave the console unable to say what just happened.
 */
export type ErrorWithRevokedKeys = ErrorResponse & { revokedKeys: AccessKeySummary[] };

export function badRequestResponse(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
}

/**
 * The person a member verb names is not in the org. About the target, not the
 * caller: `authorize` answers for a caller without a membership, with a 403.
 */
export function notAMemberResponse(
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: 'That person is not a member of this organization.',
      ...(revokedKeys ? { revokedKeys } : {}),
    })
    .build();
}

/**
 * The caller's role does not reach the target's. Every member verb refuses
 * with the same sentence; `verbPhrase` completes it with what was attempted —
 * `remove a admin`, `change a owner to member`, `invite someone as admin`.
 */
export function beyondCeilingResponse(verbPhrase: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `Your role in this organization cannot ${verbPhrase}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}
