export interface UsageResponse {
  storage: {
    usedBytes: number;
  };
  egress: {
    usedBytes: number;
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
