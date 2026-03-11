/**
 * Parse cookies from the API Gateway v2 event.
 * Payload format 2.0 puts cookies in `event.cookies` (string[])
 */
export function parseCookies(cookieArray: string[] | undefined): Record<string, string> {
  if (!cookieArray?.length) return {};
  return Object.fromEntries(
    cookieArray.flatMap((entry) => {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) return [];
      return [[entry.slice(0, eqIdx).trim(), entry.slice(eqIdx + 1).trim()]];
    }),
  );
}
