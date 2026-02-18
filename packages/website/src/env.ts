/**
 * Typed helpers for Vite environment variables.
 * Set VITE_API_URL in a .env.local file during development:
 *   VITE_API_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';
