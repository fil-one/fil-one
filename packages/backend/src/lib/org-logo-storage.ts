import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

const LOGO_UPLOAD_EXPIRY_SECONDS = 300;
const LOGO_KEY_PREFIX = 'logos/';

// Module-level cache — reused across Lambda warm starts, the same pattern
// `ddb-client.ts` uses.
let cachedClient: S3Client | null = null;

function getPlatformS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({});
  return cachedClient;
}

export interface PresignedOrgLogoUpload {
  /** Where the client POSTs the file, as a multipart form. */
  uploadUrl: string;
  /** The form fields the POST must carry alongside the file. */
  fields: Record<string, string>;
  /** The public URL to read it back from afterward. */
  logoUrl: string;
}

/**
 * A presigned POST into OrgLogoBucket, plus the public URL the object is
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
  const key = `${LOGO_KEY_PREFIX}${crypto.randomUUID()}`;

  const { url, fields } = await createPresignedPost(getPlatformS3Client(), {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, ORG_LOGO_MAX_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: LOGO_UPLOAD_EXPIRY_SECONDS,
  });

  return { uploadUrl: url, fields, logoUrl: publicOrgLogoUrl(bucket, key) };
}

/**
 * Whether `logoUrl` names an object this bucket actually holds under the
 * prefix this module ever signs uploads into.
 *
 * `POST /api/org`'s `logoUrl` is client-supplied, so accepting any
 * syntactically valid URL would let a caller point the field at an arbitrary
 * host — every member's browser would then request that host whenever the org
 * switcher renders the logo. Checking the shape isn't enough on its own,
 * since the key is a guessable-format (if not guessable-value) path; the
 * `HeadObjectCommand` confirms an object was actually uploaded to *our*
 * bucket at that key, which a spoofed URL never has.
 */
export async function isUploadedOrgLogoUrl(logoUrl: string): Promise<boolean> {
  const bucket = Resource.OrgLogoBucket.name;
  const key = orgLogoKeyFromUrl(logoUrl, bucket);
  if (!key) return false;

  try {
    await getPlatformS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The object key `logoUrl` names, or `undefined` if it isn't the shape this
 * module ever produces: the exact bucket and region this deployment signs
 * into, and a key under {@link LOGO_KEY_PREFIX}.
 */
function orgLogoKeyFromUrl(logoUrl: string, bucket: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== `${bucket}.s3.${awsRegion()}.amazonaws.com`
  ) {
    return undefined;
  }

  const key = parsed.pathname.replace(/^\//, '');
  return key.startsWith(LOGO_KEY_PREFIX) ? key : undefined;
}

/**
 * The virtual-hosted-style URL for an object in a public-read bucket. Treated
 * like `me.picture` per the plan: a plain public URL, no presigned-GET
 * machinery, so this is the one place that shape is constructed.
 */
function publicOrgLogoUrl(bucket: string, key: string): string {
  return `https://${bucket}.s3.${awsRegion()}.amazonaws.com/${key}`;
}

function awsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1';
}
