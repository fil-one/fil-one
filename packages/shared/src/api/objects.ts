export interface S3Object {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag?: string;
}

export interface ListObjectsRequest {
  bucketName: string;
  prefix?: string;
  delimiter?: string;
  nextToken?: string;
  maxKeys?: number;
}

export interface ListObjectsResponse {
  objects: S3Object[];
  prefix?: string;
  nextToken?: string;
  isTruncated: boolean;
}

export interface PresignUploadRequest {
  key: string;
  contentType: string;
  fileName: string;
  description?: string;
}

export interface PresignUploadResponse {
  url: string;
  key: string;
}

export interface DeleteObjectRequest {
  bucketName: string;
  key: string;
}
