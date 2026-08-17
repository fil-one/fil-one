import type { AuditEventType } from '../audit.js';

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

export interface RecentActivityResponse {
  activities: RecentActivity[];
}
