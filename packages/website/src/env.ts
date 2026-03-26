import { Stage } from '@filone/shared';

/**
 * Typed helpers for Vite environment variables.
 * Copy .env.local.example to .env.local and fill in values for local dev.
 *
 * VITE_API_URL              - Base URL for the Fil.one REST API
 *                             (empty in production — relative paths via CloudFront)
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';
export const STRIPE_PUBLISHABLE_KEY: string =
  import.meta.env['VITE_STRIPE_PUBLISHABLE_KEY'] ??
  'pk_test_51T2zW1AHbTIJ60DDv74RQYurdM94j0qvnJoqtrzurlbDsFgoE6SvQkTFccVKwp9kFkfv9wWC128IIpjHvmuLoVWX00ki9J0mN6';

function inferStage(): Stage {
  if (typeof window !== 'undefined' && window.location.hostname === 'app.fil.one') {
    return Stage.Production;
  }
  return Stage.Staging;
}

export const FILONE_STAGE = inferStage();
