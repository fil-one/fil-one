import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Determines the origin to use for redirects and callback URLs.
 *
 * Redirects must follow the host the user actually visited: sending someone who
 * signed in on a demo alias to `WEBSITE_URL` would bounce them onto the very
 * hostname the alias exists to avoid, and set their session cookies there.
 *
 * The viewer's hostname arrives as `x-forwarded-host`, which the Router's
 * viewer-request CloudFront function sets from the `Host` header on every route,
 * overwriting whatever the client sent. That makes it trustworthy *through*
 * CloudFront — but the API Gateway execute-api URL is publicly reachable, and on
 * that path the header is entirely attacker-controlled. `ALLOWED_REDIRECT_ORIGINS`
 * is the only thing standing between it and an open redirect, and via
 * `redirect_uri` the interception of an OAuth authorization code.
 *
 * Hence one non-obvious rule: **do not split on commas.** API Gateway joins
 * duplicate headers with commas, so `app.fil.one,attacker.example` arrives as a
 * single string that simply fails the match. Splitting and taking the first element
 * would *accept* it — the usual X-Forwarded-For advice is backwards here.
 */
export function resolveOrigin(event: APIGatewayProxyEventV2): string {
  const websiteUrl = process.env.WEBSITE_URL!;
  const allowed = new Set(
    (process.env.ALLOWED_REDIRECT_ORIGINS ?? '').split(',').filter((origin) => origin.length > 0),
  );

  // Checked first so the local Vite dev proxy keeps working. It is the only
  // caller permitted to name a non-https origin, and only because it must
  // already appear in the allowlist.
  const devOrigin = event.headers?.['x-dev-origin'];
  if (devOrigin && allowed.has(devOrigin)) return devOrigin;

  const forwardedHost = event.headers?.['x-forwarded-host'];
  if (forwardedHost) {
    // Lowercased because CloudFront does not normalise the case of `Host`.
    const candidate = `https://${forwardedHost.trim().toLowerCase()}`;
    if (allowed.has(candidate)) return candidate;
  }

  return websiteUrl;
}
