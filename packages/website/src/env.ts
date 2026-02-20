/**
 * Typed helpers for Vite environment variables.
 * Copy .env.local.example to .env.local and fill in values for local dev.
 *
 * VITE_API_URL     - Base URL for the Hyperspace REST API
 * VITE_S3_ENDPOINT - S3-compatible endpoint shown to users in Connection Details
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';
export const S3_ENDPOINT: string = import.meta.env['VITE_S3_ENDPOINT'] ?? '';
