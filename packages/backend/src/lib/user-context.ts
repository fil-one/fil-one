import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { OrgMembership } from './org-membership.ts';

export interface UserInfo {
  sub: string;
  userId: string;
  orgId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  /**
   * The caller's membership row in {@link UserInfo.orgId}, set by
   * `authMiddleware` on every cookie-authenticated request. The row rather than
   * a flattened role so the member bucket scope that lands on it reaches its
   * consumers with no new plumbing.
   *
   * The permissions it carries are not cached beside it: `permissionsForRole`
   * is a table lookup, and a second copy of derived state is one more thing
   * that can disagree with the row.
   */
  membership?: OrgMembership;
}

export interface AuthenticatedEvent extends APIGatewayProxyEventV2 {
  requestContext: APIGatewayProxyEventV2['requestContext'] & {
    userInfo: UserInfo;
    /** Set by subscriptionGuardMiddleware after resolving the billing record. */
    subscriptionStatus?: string;
    /** Set by requestDeadlineMiddleware; read it with getRequestDeadline. */
    deadline?: AbortSignal;
    /** Set by markRequestStep; logged by requestDeadlineMiddleware when the deadline fires. */
    deadlineStep?: string;
    /**
     * Kept by trackRequestStep, step name by step id; logged by
     * requestDeadlineMiddleware when the deadline fires.
     */
    deadlineStepsInFlight?: Map<string, string>;
  };
}

export function getUserInfo(event: AuthenticatedEvent): UserInfo {
  return event.requestContext.userInfo;
}

/**
 * The user's email, but only when it has been verified — suitable for
 * allowlist checks (e.g. Foundation early-access regions). Returns `undefined`
 * for unverified or missing emails so callers can't grant access off an
 * unverified address.
 */
export function getVerifiedEmail(event: AuthenticatedEvent): string | undefined {
  const { email, emailVerified } = event.requestContext.userInfo;
  return emailVerified ? email : undefined;
}

/**
 * Signal the auth middleware to force a token refresh after the handler completes.
 * Use this when a handler modifies Auth0 user data (name, email, etc.) so the
 * response includes fresh cookies with updated ID token claims.
 */
export function requestTokenRefresh(event: AuthenticatedEvent): void {
  (
    event.requestContext as AuthenticatedEvent['requestContext'] & {
      _forceTokenRefresh?: boolean;
    }
  )._forceTokenRefresh = true;
}
