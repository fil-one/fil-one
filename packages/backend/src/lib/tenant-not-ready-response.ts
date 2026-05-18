import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.js';
import type { TenantNotReadyReason } from './service-orchestrator/service-orchestrator.js';

// Handler-side mapping from an orchestrator's TenantNotReadyReason to an HTTP
// response. Kept out of the service-orchestrator module so the abstraction
// stays free of AWS Lambda response types.
const MESSAGES: Record<TenantNotReadyReason, string> = {
  'setup-incomplete': 'We are still setting up your account. Please try again in a moment.',
};

export function tenantNotReadyResponse(
  reason: TenantNotReadyReason,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({ message: MESSAGES[reason] })
    .build();
}
