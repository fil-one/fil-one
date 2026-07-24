import type { S3Region } from '@filone/shared';
import { getAvailableRegions, getStageFromHostname } from '@filone/shared';

/**
 * Regions selectable by the current user. `eu-west-1` and `us-east-1` are
 * generally available; non-GA regions (e.g. Forge's `eu-central-3`) are offered
 * only on non-production stages, so availability is derived from the stage the
 * app is served on. Kept as a hook so region availability stays sourced from one
 * place across all call sites (the region picker, "more regions coming soon"
 * hints, etc.).
 */
export function useAvailableRegions(): S3Region[] {
  return getAvailableRegions(getStageFromHostname(window.location.hostname));
}
