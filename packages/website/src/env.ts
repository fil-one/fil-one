/**
 * Typed helpers for Vite environment variables.
 * Copy .env.local.example to .env.local and fill in values for local dev.
 *
 * VITE_API_URL              - Base URL for the Fil.one REST API
 *                             (empty in production — relative paths via CloudFront)
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';
