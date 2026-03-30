import { expect } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
};

/**
 * Assert a middleware early-return matches a full ResponseBuilder response.
 * Eliminates `result!`, `body as string`, and partial field checks.
 */
export function expectErrorResponse(
  result: APIGatewayProxyStructuredResultV2 | void,
  statusCode: number,
  body: Record<string, unknown>,
) {
  expect(result).toStrictEqual({
    statusCode,
    headers: SECURITY_HEADERS,
    body: JSON.stringify(body),
  });
}
