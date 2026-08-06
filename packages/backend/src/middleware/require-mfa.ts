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
 * Gate handlers that require a strong-auth session, from the `amr` claim of
 * the ID token `authMiddleware` already verified. `'phr'` counts alongside
 * `'mfa'` because the Post-Login Action short-circuits MFA on passkey login,
 * which would otherwise lock passkey-primary users out of gated actions.
 * Refresh-token grants drop `amr`, so the gate expires on ID token refresh.
 *
 * 401 step_up_required tells the frontend to redirect through
 * `/login?acr_values=...:multi-factor`. Install AFTER `authMiddleware`.
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
 * Step-up gate only for users who actually have MFA enrolled (FIL-112). No
 * enrollment passes: for MFA-less users the email challenge is the sole second
 * factor, and an unsatisfiable amr check would lock them out. Fails closed — a
 * Management API error 5xxs rather than skipping the gate. Install AFTER
 * `authMiddleware` (verified claims + userInfo).
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
