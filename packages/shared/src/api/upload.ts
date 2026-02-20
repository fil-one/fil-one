export interface UploadRequest {
  bucketName: string;
  key: string;
  fileBase64: string;
  fileName: string;
  contentType: string;
}

export interface UploadResponse {
  status: 'success' | 'error';
  uploadId: string;
  bucketName: string;
  key: string;
  message?: string;
}
