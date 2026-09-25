import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Parse cookies from the API Gateway v2 event.
 * Payload format 2.0 puts cookies in `event.cookies` (string[]). The emulator
 * behind local deploys leaves that empty and passes the raw Cookie header, so
 * the header is the fallback.
 */
export function parseCookies(
  event: Pick<APIGatewayProxyEventV2, 'cookies' | 'headers'>,
): Record<string, string> {
  const cookieArray = event.cookies?.length ? event.cookies : event.headers?.cookie?.split(';');
  if (!cookieArray?.length) return {};
  return Object.fromEntries(
    cookieArray.flatMap((entry) => {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) return [];
      return [[entry.slice(0, eqIdx).trim(), entry.slice(eqIdx + 1).trim()]];
    }),
  );
}
