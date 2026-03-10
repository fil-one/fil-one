/**
 * Typed helpers for Vite environment variables.
 * Copy .env.local.example to .env.local and fill in values for local dev.
 *
 * VITE_API_URL              - Base URL for the Hyperspace REST API
 *                             (empty in production — relative paths via CloudFront)
 * VITE_S3_ENDPOINT          - S3-compatible endpoint shown to users in Connection Details
 * VITE_AUTH0_DOMAIN         - Auth0 tenant domain (e.g. "your-tenant.auth0.com")
 * VITE_AUTH0_CLIENT_ID      - Auth0 application client ID
 * VITE_AUTH0_AUDIENCE       - Auth0 API audience identifier
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';
export const S3_ENDPOINT: string = import.meta.env['VITE_S3_ENDPOINT'] ?? '';
// TODO [Option D]: Replace default with custom domain (e.g. 'auth.filhyperspace.com')
// once Auth0 paid plan + DNS CNAME is configured. No code changes needed.
export const AUTH0_DOMAIN: string =
  import.meta.env['VITE_AUTH0_DOMAIN'] ?? 'dev-oar2nhqh58xf5pwf.us.auth0.com';
export const AUTH0_CLIENT_ID: string = import.meta.env['VITE_AUTH0_CLIENT_ID'] ?? '';
export const AUTH0_AUDIENCE: string =
  import.meta.env['VITE_AUTH0_AUDIENCE'] ?? 'console.filhyperspace.com';
export const STRIPE_PUBLISHABLE_KEY: string =
  import.meta.env['VITE_STRIPE_PUBLISHABLE_KEY'] ??
  'pk_test_51T2zW1AHbTIJ60DDv74RQYurdM94j0qvnJoqtrzurlbDsFgoE6SvQkTFccVKwp9kFkfv9wWC128IIpjHvmuLoVWX00ki9J0mN6';
