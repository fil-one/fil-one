import { expect } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
};

/**
 * Assert a middleware early-return matches a full ResponseBuilder response.
 * Eliminates `result!`, `body as string`, and partial field checks.
 */
export function expectErrorResponse(
  result: APIGatewayProxyStructuredResultV2 | void,
  statusCode: number,
  body: Record<string, unknown>,
) {
  expect(result).toStrictEqual({
    statusCode,
    headers: SECURITY_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * Tokens the auth middleware rotated earlier in the same request, as a gate
 * downstream of it finds them on `request.internal`.
 */
export const REFRESHED_TOKENS = {
  access_token: 'new-at',
  id_token: 'new-it',
  refresh_token: 'new-rt',
};

/**
 * Assert a short-circuit response still carries the rotated session.
 *
 * Returning a response from a before hook skips the after stack that would
 * have set these, so a gate that forgets `withRefreshedCookies` spends the
 * caller's refresh token at Auth0 and never hands back the new one: the denial
 * logs them out everywhere. Five cookies, the same set the after hook writes.
 */
export function expectRefreshedCookies(result: APIGatewayProxyStructuredResultV2 | void): void {
  const cookies = (result as APIGatewayProxyStructuredResultV2 | undefined)?.cookies ?? [];
  expect(cookies).toHaveLength(5);
  expect(cookies[0]).toContain(`hs_access_token=${REFRESHED_TOKENS.access_token}`);
  expect(cookies[1]).toContain(`hs_id_token=${REFRESHED_TOKENS.id_token}`);
  expect(cookies[2]).toContain(`hs_refresh_token=${REFRESHED_TOKENS.refresh_token}`);
}
