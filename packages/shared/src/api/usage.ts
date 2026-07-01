import { TenantStatus } from './tenants.ts';

export interface UsageResponse {
  storage: {
    usedBytes: number;
  };
  egress: {
    usedBytes: number;
  };
  buckets: {
    count: number;
  };
  objects: {
    count: number;
  };
  accessKeys: {
    count: number;
  };
  tenantStatus?: TenantStatus;
}
