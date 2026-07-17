import type { S3Region } from '@filone/shared';
import { getAvailableRegions } from '@filone/shared';

/**
 * Regions selectable by the current user. Both `eu-west-1` and `us-east-1` are
 * generally available, so this returns the full region list. Kept as a hook so
 * region availability stays sourced from one place across all call sites (the
 * region picker, "more regions coming soon" hints, etc.).
 */
export function useAvailableRegions(): S3Region[] {
  return getAvailableRegions();
}
