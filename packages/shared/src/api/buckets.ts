export interface Bucket {
  name: string;
  region: string;
  createdAt: string;
  objectCount: number;
  sizeBytes: number;
  isPublic: boolean;
}

export interface ListBucketsResponse {
  buckets: Bucket[];
}

export interface CreateBucketRequest {
  name: string;
  region: string;
}

export interface CreateBucketResponse {
  bucket: Bucket;
}

export interface DeleteBucketRequest {
  bucketName: string;
}
