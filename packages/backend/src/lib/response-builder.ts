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

/**
 * The answer to a cancellation nothing can name. Rethrows when no key was
 * revoked, so the middleware answers; otherwise names the keys, which are gone
 * whatever the failure was.
 */
export function unattributableFailure(
  err: unknown,
  {
    source,
    orgId,
    revokedKeys,
  }: { source: string; orgId: string; revokedKeys: AccessKeySummary[] },
): APIGatewayProxyStructuredResultV2 {
  if (revokedKeys.length === 0) throw err;

  console.error(`[${source}] Unattributable failure after revoking keys`, {
    orgId,
    revoked: revokedKeys.length,
    error: err,
  });
  return unexpectedFailureResponse(revokedKeys);
}

/**
 * The 500 for an unattributable fault, carrying the keys a revocation pass
 * already took. `errorHandlerMiddleware` answers with it too; nothing about the
 * fault itself is disclosed either way.
 */
export function unexpectedFailureResponse(
  revokedKeys: AccessKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(500)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: 'An unexpected server error occurred. Please try again later.',
      ...(revokedKeys.length > 0 ? { revokedKeys } : {}),
    })
    .build();
}

export function badRequestResponse(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
}

/**
 * How a vendor-refusal message names what is still live: `The key "nightly"`, or
 * `3 keys ("a", "b", "c")`.
 *
 * The consequence differs per verb — the role is unchanged, the member is still
 * here, ownership has not moved — but every one of them opens this way, and a
 * plural form that drifted between them would be a worse answer in whichever
 * handler was not updated.
 */
export function refusedKeysSubject(failedKeys: readonly AccessKeySummary[]): string {
  const named = failedKeys.map((key) => `"${key.keyName}"`).join(', ');
  return failedKeys.length === 1 ? `The key ${named}` : `${failedKeys.length} keys (${named})`;
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

/**
 * The 409s a membership transaction cancels with. Each one reads a condition
 * the transaction carried as a statement about the org, and each may land after
 * a revocation, so `revokedKeys` rides along when the caller has any to report:
 * those keys are gone whatever the roster now says, and an answer that named
 * only the roster would hide half of what happened.
 */

/**
 * The decrement's own condition fired: the org is at one Owner. `remedy` is the
 * caller's way out, and it differs by verb — an Owner being removed can also be
 * replaced by transferring the seat, which a demotion cannot offer.
 */
export function lastOwnerResponse(
  remedy: string,
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: `This organization would be left without an owner. ${remedy}`,
      code: ApiErrorCode.LAST_OWNER,
      ...(revokedKeys ? { revokedKeys } : {}),
    })
    .build();
}

/**
 * The org has membership rows and no counter, so the last-Owner invariant is
 * unenforceable for it until somebody repairs the META row — which the drift
 * checker does within a day. "Contact support" is true and "you are the last
 * Owner" would not be. `attempted` is what the request could not do to the
 * counter: `updated` when its write cancelled or would have, `read` when the
 * refusal came from looking at it before anything was revoked.
 */
export function ownerCountUnavailableResponse(
  attempted: 'updated' | 'read',
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: `The organization’s owner count could not be ${attempted}. Please contact support.`,
      ...(revokedKeys ? { revokedKeys } : {}),
    })
    .build();
}

/** An invitation the change retires was accepted or revoked underneath it. */
export function invitationRaceResponse(
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: 'An invitation from that member changed while this was in flight — try again.',
      ...(revokedKeys ? { revokedKeys } : {}),
    })
    .build();
}

/**
 * A key was minted for the member after the listing this change revoked from,
 * so the fence refused the commit. The same request retried lists the new key
 * too.
 *
 * `subject` names whose key it was, since each verb reads differently: the
 * member's own address where the caller is acting on somebody else, which the
 * roster already showed them, and a description where the caller is the holder.
 * Callers passing an address fall back to a description, since a profile row
 * without one is not a reason to refuse differently.
 */
export function keyMintedResponse(
  subject: string,
  revokedKeys: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
      message: `An access key was created for ${subject} while this was in flight — try again.`,
      revokedKeys,
    })
    .build();
}

/**
 * The target's row no longer carries the role the transaction conditioned on:
 * somebody changed it while this request was in flight. `during` finishes the
 * sentence, since a PATCH and a DELETE each name what was interrupted.
 */
export function memberRoleChangedResponse(
  during: string,
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse | ErrorWithRevokedKeys>({
      message: `That member’s role changed ${during}.`,
      ...(revokedKeys ? { revokedKeys } : {}),
    })
    .build();
}
