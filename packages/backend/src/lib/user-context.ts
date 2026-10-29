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

/** What Auth0 says about a caller who has no account here yet. */
interface PendingAccountFields {
  sub: string;
  /** Minted for the account the route will create, and unused if it creates none. */
  userId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

/** A caller signing in for the first time. */
export interface NewAccount extends PendingAccountFields {
  kind: 'new';
}

/**
 * A caller whose earlier account was deleted and whose deletion has finished.
 * Their Auth0 sub came back unchanged, as a Google login's does, so their
 * identity row still carries the deletion stamp.
 */
export interface RejoiningAccount extends PendingAccountFields {
  kind: 'rejoining';
  /** The stamp on the identity row, which the new account replaces only if it is still there. */
  deletedAt: string;
}

export type PendingAccount = NewAccount | RejoiningAccount;

/**
 * A request from a caller with no account, on a route that creates the account
 * itself (`authMiddleware({ deferAccountCreation: true })`). It carries the
 * pending account in place of `userInfo`: there is no org or membership to
 * resolve yet. `Omit` keeps every other field the authenticated request carries.
 */
export interface PendingAccountEvent extends APIGatewayProxyEventV2 {
  requestContext: Omit<AuthenticatedEvent['requestContext'], 'userInfo'> & {
    pendingAccount: PendingAccount;
  };
}

/** What a route with deferred account creation receives. */
export type AccountCreatingEvent = AuthenticatedEvent | PendingAccountEvent;

export function isPendingAccountEvent(event: AccountCreatingEvent): event is PendingAccountEvent {
  return 'pendingAccount' in event.requestContext;
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
