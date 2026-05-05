import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type { StepUpRequiredResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getVerifiedIdTokenClaims } from './auth.js';

/**
 * Gate handlers that require an MFA-authenticated session. Reads the OIDC
 * `amr` claim from the ID token claims that `authMiddleware` already
 * verified (signature + audience + issuer) and stashed on `request.internal`.
 * Auth0 sets `amr: ["mfa"]` after the user satisfies an MFA challenge in
 * response to an `acr_values` step-up request. Refresh-token grants strip
 * `amr`, so the gate naturally invalidates once the access token expires
 * (~1 hour) and forces a fresh step-up.
 *
 * 401 step_up_required signals the frontend wrapper to redirect through
 * `/api/login?acr_values=...:multi-factor`.
 *
 * Must be installed AFTER `authMiddleware` so verified claims are available.
 */
export function requireMfa() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { amr } = getVerifiedIdTokenClaims(request);
    if (!amr.includes('mfa')) return stepUpResponse();
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

function stepUpResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(401)
    .body<StepUpRequiredResponse>({ error: 'step_up_required' })
    .build();
}
