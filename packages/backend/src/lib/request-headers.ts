import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Read a request header by name, whatever case it arrived in.
 *
 * Every authenticated chain installs `httpHeaderNormalizer()` ahead of the auth
 * middleware, so in practice the keys are already lower case — and API Gateway
 * lower-cases them before that. This does not depend on either: a chain
 * assembled without the normalizer would otherwise read a header the caller
 * did send as absent, and for `X-Org-Id` that means silently operating on the
 * wrong organization. Cheaper than adding a middleware to 39 chains to
 * guarantee what one lookup can.
 *
 * Trims the value, because a header whose only defect is a leading space is a
 * proxy's doing rather than the caller's.
 */
export function getRequestHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers as Record<string, string | undefined> | undefined;
  if (!headers) return undefined;

  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct.trim();

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value?.trim();
  }
  return undefined;
}
