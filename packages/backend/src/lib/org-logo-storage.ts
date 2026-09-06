import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
 */

const LOGO_UPLOAD_EXPIRY_SECONDS = 300;

/** The key prefix a logo upload lands under — shared with `isOwnedAssetUrl`. */
export const ORG_LOGO_KEY_PREFIX = 'logos/';

// Module-level cache — reused across Lambda warm starts, the same pattern
// `ddb-client.ts` uses.
let cachedClient: S3Client | null = null;

function getPlatformS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({});
  return cachedClient;
}

export interface PresignedOrgLogoUpload {
  /** Where the client PUTs the file. */
  uploadUrl: string;
  /** The public URL to read it back from afterward. */
  logoUrl: string;
}

/**
 * A presigned PUT into OrgLogoBucket, plus the public URL the object is
 * readable at once the upload lands.
 *
 * Keyed by a fresh random id rather than an orgId: the org this logo will
 * belong to does not exist yet when the upload happens, so there is nothing
 * to key it by until `POST /api/org` creates one. The handler that calls this
 * never learns which org, if any, the upload is for — it only ever hands back
 * a string for `POST /api/org`'s body to carry forward.
 */
export async function presignOrgLogoUpload({
  contentType,
}: {
  contentType: string;
}): Promise<PresignedOrgLogoUpload> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = `${ORG_LOGO_KEY_PREFIX}${crypto.randomUUID()}`;

  const uploadUrl = await getSignedUrl(
    getPlatformS3Client(),
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: LOGO_UPLOAD_EXPIRY_SECONDS },
  );

  return { uploadUrl, logoUrl: publicOrgLogoUrl(bucket, key) };
}

/**
 * The virtual-hosted-style URL for an object in a public-read bucket. Treated
 * like `me.picture` per the plan: a plain public URL, no presigned-GET
 * machinery, so this is the one place that shape is constructed.
 */
function publicOrgLogoUrl(bucket: string, key: string): string {
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Whether `url` already points at an object inside `OrgLogoBucket` under
 * `prefix` — the one shape `presignOrgLogoUpload` and `presignAvatarUpload`
 * (`avatar-storage.ts`) hand back.
 *
 * `logoUrl` and `pictureUrl` are both documented as "must already be a URL
 * our own presign endpoint returned," but the wire schema only checks that
 * the value is *a* well-formed URL — it has no way to know which bucket a
 * URL belongs to. This is the check that makes the documented invariant
 * real: `update-org.ts`, `create-org.ts`, and `update-profile.ts` all call it
 * before persisting either field, rather than trusting the string as-is.
 */
export function isOwnedAssetUrl(url: string, prefix: string): boolean {
  const bucket = Resource.OrgLogoBucket.name;
  const region = process.env.AWS_REGION || 'us-east-1';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `URL` lower-cases `hostname` per spec regardless of the input's casing,
  // so the bucket side of the comparison must match that rather than assume
  // the resource name itself is already lowercase (an S3 bucket name always
  // is, but nothing stops a mock or a future resource id from not being).
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === `${bucket}.s3.${region}.amazonaws.com`.toLowerCase() &&
    parsed.pathname.startsWith(`/${prefix}`)
  );
}
