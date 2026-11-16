import { ApiErrorCode } from '@filone/shared';
import type { PresignOp, PresignResponse, PresignResponseItem, S3Region } from '@filone/shared';

import { batchPresign } from './use-presign.js';

/** An hour, so a video paused for a while can still seek. */
export const PREVIEW_URL_EXPIRY_SECONDS = 60 * 60;

export interface PreviewObject {
  region: S3Region;
  bucketName: string;
  objectKey: string;
  versionId?: string;
}

function isTrialPresignBlocked(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === ApiErrorCode.TRIAL_PRESIGN_BLOCKED
  );
}

/**
 * A signed URL the page can load the object from. It asks for an hour first.
 * Trial accounts may not choose an expiry, since the presign handler treats a
 * custom expiry as a shareable link, so for them it falls back to the standard
 * expiry. The console cannot tell a trial from the subscription status here:
 * a member without `billing.view` cannot read it.
 */
export async function getPreviewUrl(
  { region, bucketName, objectKey, versionId }: PreviewObject,
  presign: (region: S3Region, ops: PresignOp[]) => Promise<PresignResponse> = batchPresign,
): Promise<PresignResponseItem> {
  const op: PresignOp = {
    op: 'getObject',
    bucket: bucketName,
    key: objectKey,
    ...(versionId && { versionId }),
  };
  try {
    const { items } = await presign(region, [{ ...op, expiresIn: PREVIEW_URL_EXPIRY_SECONDS }]);
    return items[0];
  } catch (error) {
    if (!isTrialPresignBlocked(error)) throw error;
    const { items } = await presign(region, [op]);
    return items[0];
  }
}
