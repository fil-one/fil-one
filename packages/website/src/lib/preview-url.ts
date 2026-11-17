import type { PresignOp, PresignResponse, PresignResponseItem, S3Region } from '@filone/shared';

import { batchPresign } from './use-presign.js';

export interface PreviewObject {
  region: S3Region;
  bucketName: string;
  objectKey: string;
  versionId?: string;
}

/**
 * A signed URL the page can load the object from, at the standard expiry. It
 * names no expiry of its own: the presign handler treats a custom expiry as a
 * shareable link and refuses it on a trial account. The preview card replaces
 * the URL when it lapses.
 */
export async function getPreviewUrl(
  { region, bucketName, objectKey, versionId }: PreviewObject,
  presign: (region: S3Region, ops: PresignOp[]) => Promise<PresignResponse> = batchPresign,
): Promise<PresignResponseItem> {
  const { items } = await presign(region, [
    { op: 'getObject', bucket: bucketName, key: objectKey, ...(versionId && { versionId }) },
  ]);
  return items[0];
}
