import type { AuditEventType } from '../audit.js';

export interface UsageDataPoint {
  date: string;
  value: number;
}

/**
 * Windows the trend endpoint answers for.
 *
 * `24h` samples hourly; the others sample daily. Anything else falls back to
 * `7d` rather than erroring, so an old client keeps working.
 */
export type UsageTrendsPeriod = '24h' | '7d' | '30d';

export interface UsageTrendsRequest {
  period: UsageTrendsPeriod;
}

export interface UsageTrendsResponse {
  /** Bytes held at the close of each bucket. A stock: read the last point. */
  storage: UsageDataPoint[];
  /**
   * Objects held at the close of each bucket. A stock, like `storage`.
   *
   * Not charted on the dashboard: an object count maps to neither the bill nor
   * a limit, and the current figure is already a stat card there. Kept in the
   * response for the usage page (FIL-1099), since the storage query returns it
   * at no extra cost.
   */
  objects: UsageDataPoint[];
  /**
   * Bytes served during each bucket. A flow: sum the points for a window
   * total, and never carry a value forward across a gap.
   */
  egress: UsageDataPoint[];
}

// ---------------------------------------------------------------------------
// Activity types – discriminated union on `resourceType`
// ---------------------------------------------------------------------------

interface BaseActivity {
  id: string;
  resourceName: string;
  timestamp: string;
}

export interface BucketActivity extends BaseActivity {
  resourceType: 'bucket';
  action: 'bucket.created' | 'bucket.deleted';
}

export interface ObjectActivity extends BaseActivity {
  resourceType: 'object';
  action: 'object.uploaded' | 'object.deleted';
  sizeBytes?: number;
}

export interface KeyActivity extends BaseActivity {
  resourceType: 'key';
  /**
   * Derived from the audit union so this feed and the audit log cannot end up
   * calling the same thing two names: the dashboard renders "deleted", so the
   * event type is `key.deleted` and both read from one list.
   */
  action: Extract<AuditEventType, 'key.created' | 'key.deleted'>;
}

export type RecentActivity = BucketActivity | ObjectActivity | KeyActivity;

/**
 * Human labels for activity actions. The resource is already named and badged
 * on the row, so the label carries only what happened.
 */
export const ACTIVITY_ACTION_LABELS: Record<RecentActivity['action'], string> = {
  'bucket.created': 'Created',
  'bucket.deleted': 'Deleted',
  'object.uploaded': 'Uploaded',
  'object.deleted': 'Deleted',
  'key.created': 'Created',
  'key.deleted': 'Deleted',
};

/**
 * Resolve an activity action to its human label.
 *
 * The {@link ACTIVITY_ACTION_LABELS} record is exhaustive over the known union,
 * so a newly added action still can't compile without a label. This guards the
 * runtime case the type can't: a backend rolling out an action the console
 * doesn't know yet. Rather than render `undefined`, it humanizes the verb after
 * the last dot (`object.restored` -> `Restored`) so the row still reads as copy.
 */
export function getActivityActionLabel(action: string): string {
  const label = ACTIVITY_ACTION_LABELS[action as RecentActivity['action']];
  if (label) return label;

  const verb = action.split('.').pop() ?? '';
  return verb ? verb.charAt(0).toUpperCase() + verb.slice(1) : 'Activity';
}

export interface RecentActivityResponse {
  activities: RecentActivity[];
}
