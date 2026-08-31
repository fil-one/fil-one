import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { OrgMembership } from './org-membership.js';

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
   * The RAG bearer branch bypasses `authMiddleware` entirely and resolves the
   * key creator's membership itself, so this is set there too — a key whose
   * creator has left the org is refused rather than served.
   *
   * The permissions it carries are not cached beside it: `permissionsForRole`
   * is a table lookup, and a second copy of derived state is one more thing
   * that can disagree with the row.
   */
  membership?: OrgMembership;
  /**
   * Set only by the RAG bearer branch: this session was minted from an API key,
   * not from somebody's login. {@link UserInfo.sub} then names the key rather
   * than an Auth0 identity, so nothing keyed on `sub` — trial entitlement above
   * all — may run for it, and a membership denial is a revoked key creator
   * rather than an account the conversion missed.
   *
   * A flag rather than a `sub` prefix test, so the two consumers agree on what
   * makes a session synthetic and neither depends on how the key id is spelled.
   */
  apiKeySession?: true;
}

export interface AuthenticatedEvent extends APIGatewayProxyEventV2 {
  requestContext: APIGatewayProxyEventV2['requestContext'] & {
    userInfo: UserInfo;
    /** Set by subscriptionGuardMiddleware after resolving the billing record. */
    subscriptionStatus?: string;
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
