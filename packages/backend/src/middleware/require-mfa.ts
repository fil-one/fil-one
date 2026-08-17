import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type { StepUpRequiredResponse } from '@filone/shared';
import { getMfaEnrollments, MFA_GUARDIAN_TYPES } from '../lib/auth0-management.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getMfaEnrollments } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { getVerifiedIdTokenClaims, withRefreshedCookies } from './auth.js';

/**
 * Gate handlers that require a strong-auth session. Reads the OIDC `amr`
 * claim from the ID token claims that `authMiddleware` already verified
 * (signature + audience + issuer) and stashed on `request.internal`.
 *
 * Accepts either `'mfa'` (set after the user satisfies an MFA challenge in
 * response to an `acr_values` step-up request) or `'phr'` (set by Auth0 when
 * the user authenticated with a phishing-resistant factor — primarily a
 * passkey). Matches the Post-Login Action, which short-circuits MFA when a
 * passkey login was performed: passkey-primary users would otherwise be
 * blocked from step-up-gated actions immediately after a passkey login.
 *
 * Refresh-token grants strip `amr` from newly issued ID token claims, so the
 * gate naturally invalidates once the client refreshes the ID token and
 * forces a fresh sign-in to regain strong-auth state.
 *
 * 401 step_up_required signals the frontend wrapper to redirect through
 * `/login?acr_values=...:multi-factor`.
 *
 * Must be installed AFTER `authMiddleware` so verified claims are available.
 */
export function requireMfa() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { amr } = getVerifiedIdTokenClaims(request);
    // Through withRefreshedCookies: a step-up prompt must not also cost the
    // caller the session this request just rotated.
    if (!amr.includes('mfa') && !amr.includes('phr')) {
      return withRefreshedCookies(request, stepUpResponse());
    }
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

/**
 * Like {@link requireMfa}, but passes a user who has no MFA enrolled at all.
 *
 * For actions where the strict gate would be unsatisfiable rather than
 * protective: an MFA-less user can never produce `mfa` in `amr`, so requireMfa
 * would make the action permanently impossible for them. Account deletion is
 * exactly that case, and the emailed code is their second factor.
 *
 * A Management API failure propagates, so the gate fails closed.
 */
export function requireMfaIfEnrolled() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { amr } = getVerifiedIdTokenClaims(request);
    if (amr.includes('mfa') || amr.includes('phr')) return;

    const { sub } = getUserInfo(request.event as AuthenticatedEvent);
    const enrollments = await getMfaEnrollments(sub);
    if (enrollments.some((enrollment) => MFA_GUARDIAN_TYPES.has(enrollment.type))) {
      return stepUpResponse();
    }
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

function stepUpResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(401)
    .body<StepUpRequiredResponse>({ error: 'step_up_required' })
    .build();
}

/**
 * How recently the caller must have authenticated for a fresh sign-in to count
 * as the step-up.
 *
 * Five minutes: long enough to survive the redirect back and a form submit,
 * short enough that a session somebody walked away from does not still carry the
 * authority to give the organization away.
 */
export const STEP_UP_MAX_AGE_SECONDS = 300;

/**
 * Gate an action on strong auth, without demanding what a user cannot supply.
 *
 * `requireMfa` asks for an `amr` a user with nothing enrolled can never produce,
 * so on the org actions it guards it would deny outright rather than prompt.
 * This variant asks the question the ADR settles on instead: has this caller
 * proved themselves again, just now?
 *
 * Three ways that is satisfied, in the order they are cheapest to check:
 *
 * 1. `amr` carries `mfa` or `phr` — an MFA challenge or a phishing-resistant
 *    factor was satisfied for this session.
 * 2. `auth_time` is within {@link STEP_UP_MAX_AGE_SECONDS} and the user has
 *    nothing enrolled at Guardian — the step-up they can do IS re-authenticating,
 *    which `max_age=0` forces. This is the SAML-and-SSO case the plain gate
 *    passes silently today: a federated session never carries `mfa`, and its
 *    remedy can never be an Auth0 enrollment.
 * 3. Nothing else. A stale session, and an enrolled user whose session predates
 *    their last challenge, both get the 401 that sends the console through
 *    `/login?acr_values=…&max_age=0`.
 *
 * The enrollment read costs an Auth0 Management call and only runs in case 2. If
 * it fails, a caller who authenticated moments ago is let through and the failure
 * is logged: denying instead would loop a user with no MFA through a redirect
 * that can never satisfy a check we are unable to make.
 *
 * Must be installed AFTER `authMiddleware`, which verifies the claims and
 * resolves the caller.
 */
export function requireMfaIfEnrolled() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { amr, authTime } = getVerifiedIdTokenClaims(request);
    if (amr.includes('mfa') || amr.includes('phr')) return;

    const { sub } = (request.event as AuthenticatedEvent).requestContext.userInfo;
    if (authenticatedRecently(authTime) && !(await hasMfaEnrolled(sub))) return;

    // Through withRefreshedCookies: a step-up prompt must not also cost the
    // caller the session this request just rotated.
    return withRefreshedCookies(request, stepUpResponse());
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

function authenticatedRecently(authTime: number | null): boolean {
  if (authTime === null) return false;
  return Date.now() / 1000 - authTime <= STEP_UP_MAX_AGE_SECONDS;
}

async function hasMfaEnrolled(sub: string): Promise<boolean> {
  try {
    return (await getMfaEnrollments(sub)).length > 0;
  } catch (err) {
    console.error(
      '[require-mfa] Could not read MFA enrollments — accepting the fresh authentication',
      { error: err },
    );
    return false;
  }
}
