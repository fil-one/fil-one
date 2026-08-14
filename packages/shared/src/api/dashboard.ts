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
  action: 'key.created' | 'key.deleted';
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

export interface RecentActivityResponse {
  activities: RecentActivity[];
}
