import {
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { ORG_LOGO_MAX_BYTES } from '@filone/shared';
import { Resource } from 'sst';

/**
 * Presigned uploads into OrgLogoBucket — a small, dedicated, public-read
 * bucket for org logos, separate from the tenant object storage `presign.ts`
 * signs into.
 *
 * A logo is platform identity data, not tenant data: it is uploaded during
 * "Create organization," before the org (and therefore any tenant) exists, by
 * a caller who is not acting against any particular org's S3 credentials.
 * Sharing `presign.ts`'s tenant-scoped signer here would mean either inventing
 * a tenant for an org that has none yet, or handing this upload a trust
 * boundary that belongs to customer data. This bucket lives in our own AWS
 * account, signed with the Lambda's own role — the same shape as
 * `UserFilesBucket`, not as a tenant's S3-compatible endpoint.
 *
 * The upload is a presigned POST policy, not a presigned PUT: a PUT's query-string
 * signature does not bind the request body's size, so a caller who reused the
 * signed URL directly (bypassing the website's own client-side size check)
 * could push an arbitrarily large object into the bucket. A POST policy's
 * `content-length-range` condition is enforced by S3 itself before it accepts
 * the object, which is the only place this can actually be enforced.
 */

const UPLOAD_EXPIRY_SECONDS = 300;
const LOGO_KEY_PREFIX = 'logos/';

/**
 * Every upload into this bucket lands carrying this tag, and the bucket's
 * lifecycle rule (sst.config.ts) expires whatever still carries it a day later.
 * The handler that saves an upload's URL removes it: see {@link withClaimedUpload}.
 */
const UNCLAIMED_TAG = { Key: 'state', Value: 'unclaimed' } as const;

/** The same tag in the XML form a POST policy's `tagging` field takes. */
const UNCLAIMED_TAGGING_XML = `<Tagging><TagSet><Tag><Key>${UNCLAIMED_TAG.Key}</Key><Value>${UNCLAIMED_TAG.Value}</Value></Tag></TagSet></Tagging>`;

const s3 = new S3Client({});

/**
 * A presigned POST into OrgLogoBucket under `prefix`, plus the public URL the
 * object is readable at once the upload lands. Keyed by a fresh random id, so
 * nothing about the caller or the org needs to be in the key.
 */
export async function presignUpload({
  prefix,
  maxBytes,
  contentType,
}: {
  prefix: string;
  maxBytes: number;
  contentType: string;
}): Promise<{ uploadUrl: string; fields: Record<string, string>; url: string }> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = `${prefix}${crypto.randomUUID()}`;

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
      ['eq', '$tagging', UNCLAIMED_TAGGING_XML],
    ],
    Fields: { 'Content-Type': contentType, tagging: UNCLAIMED_TAGGING_XML },
    Expires: UPLOAD_EXPIRY_SECONDS,
  });

  return { uploadUrl: url, fields, url: `https://${bucketHost(bucket)}/${key}` };
}

/**
 * A presigned logo upload. The org it will belong to does not exist yet, so
 * the handler never learns which org, if any, the upload is for; it hands back
 * a string for `POST /api/org`'s body to carry forward.
 */
export async function presignOrgLogoUpload({ contentType }: { contentType: string }) {
  const { url, ...upload } = await presignUpload({
    prefix: LOGO_KEY_PREFIX,
    maxBytes: ORG_LOGO_MAX_BYTES,
    contentType,
  });
  return { ...upload, logoUrl: url };
}

/**
 * Whether `logoUrl` names an unclaimed upload this bucket actually holds under
 * the prefix this module ever signs uploads into.
 *
 * `POST /api/org`'s `logoUrl` is client-supplied, so accepting any
 * syntactically valid URL would let a caller point the field at an arbitrary
 * host — every member's browser would then request that host whenever the org
 * switcher renders the logo. Checking the shape isn't enough on its own,
 * since the key is a guessable-format (if not guessable-value) path; reading
 * the object's tags confirms an object was actually uploaded to *our* bucket
 * at that key, which a spoofed URL never has. Requiring the unclaimed tag also
 * keeps a logo another org already saved from being pointed at, and so from
 * being deleted out from under it later. The check and the claim are separate
 * steps, so two creates racing with one fresh upload could both pass; the cost
 * is two orgs sharing one image, which is not worth a lock.
 */
export async function isUploadedOrgLogoUrl(logoUrl: string): Promise<boolean> {
  return await isUnclaimedUpload(logoUrl, LOGO_KEY_PREFIX);
}

/**
 * Save an accepted logo with `save`, claimed out of the lifecycle rule's reach
 * first. See {@link withClaimedUpload}.
 */
export async function withClaimedOrgLogo<T>(logoUrl: string, save: () => Promise<T>): Promise<T> {
  return await withClaimedUpload(logoUrl, LOGO_KEY_PREFIX, save);
}

/** Delete the logo a new one replaced, once the org no longer points at it. */
export async function deleteReplacedOrgLogo(logoUrl: string | undefined): Promise<void> {
  if (logoUrl) await deleteUpload(logoUrl, LOGO_KEY_PREFIX);
}

/**
 * The check {@link isUploadedOrgLogoUrl} makes, for any prefix in this bucket.
 * Other uploads share the bucket under prefixes of their own, and a
 * client-supplied URL for any of them carries the same risk a logo URL does.
 */
export async function isUnclaimedUpload(url: string, prefix: string): Promise<boolean> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = keyFromBucketUrl(url, bucket, prefix);
  if (!key) return false;

  try {
    const { TagSet } = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
    return (TagSet ?? []).some(
      (tag) => tag.Key === UNCLAIMED_TAG.Key && tag.Value === UNCLAIMED_TAG.Value,
    );
  } catch {
    // No such object, most often: nothing was ever uploaded at that key.
    return false;
  }
}

/**
 * Run `save`, which points something at the upload `url` names, with the
 * upload claimed (its unclaimed tag removed) first.
 *
 * Claimed before the save, and a failed claim fails the request: a URL saved
 * while the object still carried the tag would be deleted by the lifecycle
 * rule a day later, out from under everything that shows it. A save that then
 * fails puts the tag back, so a retry with the same upload still passes the
 * unclaimed check and an abandoned one still expires.
 */
export async function withClaimedUpload<T>(
  url: string,
  prefix: string,
  save: () => Promise<T>,
): Promise<T> {
  await claimUpload(url, prefix);
  try {
    return await save();
  } catch (err) {
    await unclaimUpload(url, prefix);
    throw err;
  }
}

/** Remove the unclaimed tag from the upload `url` names. Throws on failure. */
async function claimUpload(url: string, prefix: string): Promise<void> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = keyFromBucketUrl(url, bucket, prefix);
  if (!key) return;
  await s3.send(new DeleteObjectTaggingCommand({ Bucket: bucket, Key: key }));
}

/**
 * Put the unclaimed tag back on an upload whose save failed. Never throws: the
 * save's own error is the one the caller needs, and the cost of this failing
 * too is one image nothing points at, kept rather than expired.
 */
async function unclaimUpload(url: string, prefix: string): Promise<void> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = keyFromBucketUrl(url, bucket, prefix);
  if (!key) return;

  try {
    await s3.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        Tagging: { TagSet: [{ ...UNCLAIMED_TAG }] },
      }),
    );
  } catch (err) {
    console.error('[org-logo-storage] Failed to unclaim an upload whose save failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete the upload `url` names, once whatever saved it has moved on to another.
 * A URL that isn't one of this bucket's is left alone. Never throws: the save
 * it follows already landed, and a file left behind costs storage, not
 * correctness.
 */
export async function deleteUpload(url: string, prefix: string): Promise<void> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = keyFromBucketUrl(url, bucket, prefix);
  if (!key) return;

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.error('[org-logo-storage] Failed to delete a replaced upload', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The object key `url` names, or `undefined` if it isn't the shape this
 * bucket's uploads ever produce: the exact bucket and region this deployment
 * signs into, and a key under `prefix`.
 */
function keyFromBucketUrl(url: string, bucket: string, prefix: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  // `URL` lowercases the hostname, so the expected one is lowercased to match.
  if (parsed.protocol !== 'https:' || parsed.hostname !== bucketHost(bucket).toLowerCase()) {
    return undefined;
  }

  const key = parsed.pathname.replace(/^\//, '');
  return key.startsWith(prefix) ? key : undefined;
}

/**
 * The virtual-hosted-style host of the public-read bucket: uploads are read
 * back from a plain public URL, with no presigned GET.
 */
function bucketHost(bucket: string): string {
  return `${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
}
