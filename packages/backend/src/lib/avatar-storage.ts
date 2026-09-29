import { AVATAR_MAX_BYTES } from '@filone/shared';
import type { DeleteUploadOptions } from './org-logo-storage.ts';
import {
  withClaimedUpload,
  deleteUpload,
  isUnclaimedUpload,
  presignUpload,
} from './org-logo-storage.ts';

/**
 * Presigned uploads into OrgLogoBucket, under an `avatars/` prefix rather than
 * a bucket of its own: a personal avatar is the same shape of thing as an org
 * logo (public-read platform identity data, not tenant data), and the bucket
 * is already public-read and already carries one prefixed namespace
 * (`logos/`) alongside another. Reuses `org-logo-storage.ts`'s presigned POST
 * (so S3 enforces the size ceiling) and its unclaimed tag (so an upload nobody
 * saves expires).
 */

const AVATAR_KEY_PREFIX = 'avatars/';

/** A presigned POST into OrgLogoBucket under `avatars/`. */
export async function presignAvatarUpload({ contentType }: { contentType: string }) {
  const { url, ...upload } = await presignUpload({
    prefix: AVATAR_KEY_PREFIX,
    maxBytes: AVATAR_MAX_BYTES,
    contentType,
  });
  return { ...upload, pictureUrl: url };
}

/**
 * Whether `pictureUrl` names an unclaimed avatar this bucket actually holds.
 *
 * `PATCH /api/me/profile` writes the URL to the caller's Auth0 profile, and
 * every console that renders their avatar then requests it. Accepting any URL
 * would let a caller point that at a host of their choosing, so it has to be
 * an object an avatar upload actually put under {@link AVATAR_KEY_PREFIX}.
 */
export async function isUploadedAvatarUrl(pictureUrl: string): Promise<boolean> {
  return await isUnclaimedUpload(pictureUrl, AVATAR_KEY_PREFIX);
}

/**
 * Save an accepted avatar with `save`, claimed out of the lifecycle rule's
 * reach first. See {@link withClaimedUpload}.
 */
export async function withClaimedAvatar<T>(pictureUrl: string, save: () => Promise<T>): Promise<T> {
  return await withClaimedUpload(pictureUrl, AVATAR_KEY_PREFIX, save);
}

/**
 * Delete the avatar a new one replaced. A picture from anywhere else (a social
 * provider's, most often) is left alone: only our own uploads are ours to
 * remove.
 */
export async function deleteReplacedAvatar(
  pictureUrl: string | undefined,
  options?: DeleteUploadOptions,
): Promise<void> {
  if (pictureUrl) await deleteUpload(pictureUrl, AVATAR_KEY_PREFIX, options);
}
