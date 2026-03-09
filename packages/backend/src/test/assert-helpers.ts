import { expect } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json',
  'Content-Security-Policy': "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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
