import type { PresignOp, PresignResponse, S3Region } from '@filone/shared';
import { apiRequest } from './api.js';

/**
 * Request one or more presigned S3 URLs from the backend.
 * The returned items array matches the input ops array by index.
 */
export function batchPresign(region: S3Region, ops: PresignOp[]): Promise<PresignResponse> {
  const qs = new URLSearchParams({ region }).toString();
  return apiRequest<PresignResponse>(`/presign?${qs}`, {
    method: 'POST',
    body: JSON.stringify(ops),
  });
}
