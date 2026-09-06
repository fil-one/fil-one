import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resource } from 'sst';

export { isOwnedAssetUrl } from './org-logo-storage.js';

/**
 * Presigned uploads into OrgLogoBucket, under an `avatars/` prefix rather than
 * a bucket of its own: a personal avatar is the same shape of thing as an org
 * logo (public-read platform identity data, not tenant data), and the bucket
 * is already public-read and already carries one prefixed namespace
 * (`logos/`) alongside another. See `org-logo-storage.ts`, which this mirrors.
 */

const AVATAR_UPLOAD_EXPIRY_SECONDS = 300;

/** The key prefix an avatar upload lands under — shared with `isOwnedAssetUrl`. */
export const AVATAR_KEY_PREFIX = 'avatars/';

let cachedClient: S3Client | null = null;

function getPlatformS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({});
  return cachedClient;
}

export interface PresignedAvatarUpload {
  /** Where the client PUTs the file. */
  uploadUrl: string;
  /** The public URL to read it back from afterward. */
  pictureUrl: string;
}

/**
 * A presigned PUT into OrgLogoBucket under `avatars/`, plus the public URL
 * the object is readable at once the upload lands.
 *
 * Keyed by a fresh random id, same as the logo upload: nothing about the
 * caller's identity needs to be in the key, and a random id means an old
 * avatar simply stops being referenced rather than needing to be deleted.
 */
export async function presignAvatarUpload({
  contentType,
}: {
  contentType: string;
}): Promise<PresignedAvatarUpload> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = `${AVATAR_KEY_PREFIX}${crypto.randomUUID()}`;

  const uploadUrl = await getSignedUrl(
    getPlatformS3Client(),
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: AVATAR_UPLOAD_EXPIRY_SECONDS },
  );

  return { uploadUrl, pictureUrl: publicAvatarUrl(bucket, key) };
}

/** The virtual-hosted-style URL for an object in the public-read bucket. */
function publicAvatarUrl(bucket: string, key: string): string {
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
