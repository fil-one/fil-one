import type { RetentionDurationType, RetentionMode } from '@filone/shared';

/**
 * Formats a default retention policy as `"Compliance · 30 days"`, or null when
 * the bucket has no complete policy. Shared so the bucket detail card and the
 * buckets table can't word the same policy differently.
 */
export function formatRetention(
  mode?: RetentionMode,
  duration?: number,
  durationType?: RetentionDurationType,
): string | null {
  if (!mode || !duration || !durationType) return null;
  const unit =
    durationType === 'y' ? (duration === 1 ? 'year' : 'years') : duration === 1 ? 'day' : 'days';
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${duration} ${unit}`;
}

/**
 * A default retention policy as a phrase for the line under a bucket's name,
 * `"15-day compliance retention"`, or null when the bucket has no complete
 * policy. The duration comes first so the phrase needs no comma or separator
 * of its own inside a line already split by dots.
 */
export function describeRetention(
  mode?: RetentionMode,
  duration?: number,
  durationType?: RetentionDurationType,
): string | null {
  if (!mode || !duration || !durationType) return null;
  return `${duration}-${durationType === 'y' ? 'year' : 'day'} ${mode.toLowerCase()} retention`;
}
