export interface S3Object {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag: string;
  contentType: string;
  cid?: string;
  description?: string;
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

export interface UploadObjectRequest {
  bucketName: string;
  key: string;
  fileBase64: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  description?: string;
}

export interface UploadObjectResponse {
  uploadUrl: string;
  object: S3Object;
}

export interface DeleteObjectRequest {
  bucketName: string;
  key: string;
}
