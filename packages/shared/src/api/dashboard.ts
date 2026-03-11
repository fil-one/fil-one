export interface DashboardStats {
  storage: {
    usedBytes: number;
    limitBytes: number;
  };
  downloads: {
    usedBytes: number;
    limitBytes: number;
  };
  buckets: {
    count: number;
    limit: number;
  };
  objects: {
    count: number;
  };
  accessKeys: {
    count: number;
    limit: number;
  };
}

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

export type ActivityAction =
  | 'bucket.created'
  | 'bucket.deleted'
  | 'object.uploaded'
  | 'object.deleted'
  | 'key.created'
  | 'key.deleted';

export interface RecentActivity {
  id: string;
  action: ActivityAction;
  resourceType: 'bucket' | 'object' | 'key';
  resourceName: string;
  timestamp: string;
}

export interface RecentActivityResponse {
  activities: RecentActivity[];
}
