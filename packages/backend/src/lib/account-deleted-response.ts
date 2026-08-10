import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, CSRF_COOKIE_NAME } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { makeClearAuthCookies, ResponseBuilder } from './response-builder.js';

/**
 * The one ACCOUNT_DELETED response (FIL-112). Every emitter goes through this
 * function — the status and the body shape are not each caller's business.
 *
 * **Status is 410, everywhere.** It used to be 401 in the auth middleware and
 * 410 in the billing handlers, which meant the same condition reached the
 * client as two different contracts. 410 wins because:
 *
 * - It is the team preference on record.
 * - 401 means "authenticate and try again", and for a permanently deleted
 *   account that invitation can only loop: the Auth0 SSO session silently
 *   re-authenticates the same identity, which is exactly the loop
 *   `auth-callback` already had to add a `/account-deleted` redirect to break.
 *   410 says the resource is gone for good, which is the truth.
 * - The condition is not about credentials at all — the credentials are valid;
 *   the account behind them no longer exists.
 *
 * Clients must branch on `code === ACCOUNT_DELETED`, never on the bare status:
 * 410 is already in use for "the deletion code expired".
 *
 * `Cache-Control: no-store` is not decoration. RFC 9110 §15.1 lists 410 as
 * *heuristically cacheable* where 401 is not, so moving this response onto 410
 * put it on a status a shared cache may store on its own initiative — and
 * `ResponseBuilder.build()` sets no cache directive. Our own edge is safe
 * (`/api/*` is routed with `AWS_CACHING_DISABLED_POLICY`), but a corporate or
 * ISP proxy in front of a user is not ours to configure, and a cached 410 would
 * lock out that user after they signed up again.
 *
 * `clearSession` adds the full set of clear-cookie headers. The auth
 * middleware passes it so the dead session is torn down at the same moment the
 * client is told why; handlers reached *through* that middleware do not, since
 * their caller still holds a session the middleware itself will end on the
 * next request.
 */
export function accountDeletedResponse(
  options: { clearSession?: boolean } = {},
): APIGatewayProxyStructuredResultV2 {
  const builder = new ResponseBuilder()
    .status(410)
    .header('Cache-Control', 'no-store')
    .body<ErrorResponse>({
      message: 'Account has been deleted',
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
  if (options.clearSession) {
    for (const cookie of makeClearAuthCookies(CSRF_COOKIE_NAME)) {
      builder.addCookie(cookie);
    }
  }
  return builder.build();
}
