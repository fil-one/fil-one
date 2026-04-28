import { Stage, getStageFromHostname } from '@filone/shared';

/**
 * Typed helpers for Vite environment variables.
 * Copy .env.local.example to .env.local and fill in values for local dev.
 *
 * VITE_API_URL              - Base URL for the Fil.one REST API
 *                             (empty in production — relative paths via CloudFront)
 */
export const API_URL: string = import.meta.env['VITE_API_URL'] ?? '';

function inferStage(): Stage {
  if (typeof window === 'undefined') return Stage.Staging;
  return getStageFromHostname(window.location.hostname);
}

export const FILONE_STAGE = inferStage();
