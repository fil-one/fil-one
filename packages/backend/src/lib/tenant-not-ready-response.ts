import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.js';

export function tenantNotReadyResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({
      message: 'We are still setting up your account. Please try again in a moment.',
    })
    .build();
}
