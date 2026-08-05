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
import { getUserInfo, type AuthenticatedEvent } from '../lib/user-context.js';
import { getVerifiedIdTokenClaims } from './auth.js';

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
    if (!amr.includes('mfa') && !amr.includes('phr')) return stepUpResponse();
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

/**
 * Step-up gate only for users who actually have MFA enrolled (FIL-112
 * account deletion). A strong-auth session (`amr` contains 'mfa'/'phr')
 * passes immediately with no Management API call. Otherwise Auth0 is
 * consulted: any confirmed MFA enrollment demands step-up; none passes —
 * for MFA-less users the caller's email challenge is the sole second
 * factor, and they must not be blocked by an unsatisfiable amr check.
 *
 * Fails closed: a Management API error propagates to
 * `errorHandlerMiddleware` as a 5xx rather than skipping the gate.
 *
 * Must be installed AFTER `authMiddleware` (verified claims + userInfo).
 */
export function requireMfaIfEnrolled() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { amr } = getVerifiedIdTokenClaims(request);
    if (amr.includes('mfa') || amr.includes('phr')) return;

    const { sub } = getUserInfo(request.event as AuthenticatedEvent);
    const enrollments = await getMfaEnrollments(sub);
    if (enrollments.some((e) => MFA_GUARDIAN_TYPES.has(e.type))) return stepUpResponse();
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

function stepUpResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(401)
    .body<StepUpRequiredResponse>({ error: 'step_up_required' })
    .build();
}
