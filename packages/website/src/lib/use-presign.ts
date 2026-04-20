import type { PresignOp, PresignResponse } from '@filone/shared';
import { apiRequest } from './api.js';

/**
 * Request one or more presigned S3 URLs from the backend.
 * The returned items array matches the input ops array by index.
 */
export function batchPresign(ops: PresignOp[]): Promise<PresignResponse> {
  return apiRequest<PresignResponse>('/presign', {
    method: 'POST',
    body: JSON.stringify(ops),
  });
}
