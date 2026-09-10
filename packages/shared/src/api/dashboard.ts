import type { AuditEventType } from '../audit.ts';

export interface UsageDataPoint {
  date: string;
  value: number;
}

export interface UsageTrendsRequest {
  period: '7d' | '30d';
}

export interface UsageTrendsResponse {
  storage: UsageDataPoint[];
  objects: UsageDataPoint[];
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
