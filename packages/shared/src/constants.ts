/** Deployment stages. */
export enum Stage {
  Production = 'production',
  Staging = 'staging',
}

export const DOCS_URL = 'https://docs.fil.one';

/** Available S3 regions. */
export enum S3Region {
  EuWest1 = 'eu-west-1',
  UsEast1 = 'us-east-1',
  /** Forge-backed. Not yet GA — non-production stages only (see getAvailableRegions). */
  EuCentral3 = 'eu-central-3',
}

/** Default S3 region for Fil One. */
export const S3_REGION = S3Region.EuWest1 satisfies S3Region;

/** Human-readable region labels. */
export const REGION_LABELS: Record<S3Region, string> = {
  [S3Region.EuWest1]: 'Europe (France)',
  [S3Region.UsEast1]: 'US East (Michigan)',
  [S3Region.EuCentral3]: 'Europe (Amsterdam)',
};

/** Format a region as `"Europe (France) eu-west-1"`. */
export function formatRegion(region: S3Region | string): string {
  const label = REGION_LABELS[region as S3Region];
  return label ? `${label} ${region}` : region;
}

/**
 * Resolve a region value to its human-readable label.
 *
 * Defaults to the label of {@link S3_REGION} when the input is null/undefined,
 * and falls back to the raw region string when it isn't a known {@link S3Region}.
 */
export function getRegionLabel(region: S3Region | string | null | undefined): string {
  const r = region ?? S3_REGION;
  return REGION_LABELS[r as S3Region] ?? r;
}

/** Filecoin Foundation email domain, allowlisted for early-access features (e.g. RAG). */
export const FOUNDATION_EMAIL_DOMAIN = '@fil.org';

/**
 * True when `email` is a Filecoin Foundation address.
 * The caller is responsible for ensuring the email is verified before
 * granting any allowlist-based access.
 */
export function isFoundationEmail(email: string | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(FOUNDATION_EMAIL_DOMAIN);
}

/**
 * Regions available to users. `eu-west-1` and `us-east-1` are generally
 * available in every stage; `eu-central-3` (Forge) is not yet GA and is only
 * offered on non-production stages. Pass the deployment `stage`; only
 * `production` returns the GA-only set.
 * The per-region S3 endpoints still vary by stage — see {@link getS3Endpoint}.
 *
 * Note to developers: do not remove stage argument from this function, even if
 * unused. It causes considerable churn and it is likely in the future that we
 * will want staging only regions temporarily.
 */
export function getAvailableRegions(stage: Stage | string): S3Region[] {
  const regions: S3Region[] = [S3Region.EuWest1, S3Region.UsEast1];
  if (stage !== Stage.Production) {
    regions.push(S3Region.EuCentral3);
  }
  return regions;
}

/**
 * Checks if the region is one Fil One supports for the given stage. Provides
 * type-narrowing information to TypeScript, changing `region` from `string` to
 * `S3Region` when the function returns `true`. Pass `stage` so non-GA regions
 * (e.g. `eu-central-3`) validate on non-production stages.
 *
 * Note to developers: do not remove stage argument from this function, even if
 * unused. It causes considerable churn and it is likely in the future that we
 * will want staging only regions temporarily.
 */
export function isSupportedRegion(region: string, stage: Stage | string): region is S3Region {
  return getAvailableRegions(stage).includes(region as S3Region);
}

/**
 * Whether the region supports bucket-management operations (create/delete) via
 * the S3 API. Supported everywhere except the Aurora region (`eu-west-1`), which
 * cannot manage buckets through the S3 API.
 */
export function supportsBucketManagement(region: S3Region): boolean {
  return region !== S3Region.EuWest1;
}

/**
 * Domain dedicated to user data (FIL-627).
 *
 * The gateways serve untrusted, user-controlled content, and reputation systems
 * act on the registrable domain rather than the subdomain — so hosting that
 * content under `fil.one` means one abusive upload through any single regional
 * operator can flag the console, website, docs and company email along with it.
 * Nothing but user data is served from here.
 */
const CONTENT_DATA_DOMAIN = 's3.filonecontent.com';

/** The original data domain, shared with front-of-house. Being migrated away from. */
const LEGACY_DATA_DOMAIN = 's3.fil.one';

/**
 * Data domain serving each production region's S3 gateway.
 *
 * Regions migrate one at a time. Each is run by an independent operator that
 * terminates TLS itself, so each has to obtain its own certificate for its
 * hostname under {@link CONTENT_DATA_DOMAIN} before it can be flipped — and a
 * region must not be flipped before then, or every request to it fails TLS.
 * Flipping one entry here is the whole change for that region.
 *
 * `eu-central-3` starts on the content domain: it is not GA in production and
 * has never had a `fil.one` hostname, so there is nothing to deprecate. New
 * regions should launch on the content domain and never appear on the legacy one.
 */
const PROD_DATA_DOMAIN_BY_REGION: Record<S3Region, string> = {
  [S3Region.EuWest1]: LEGACY_DATA_DOMAIN,
  [S3Region.UsEast1]: LEGACY_DATA_DOMAIN,
  [S3Region.EuCentral3]: CONTENT_DATA_DOMAIN,
};

/**
 * Build the S3-compatible endpoint URL for a given region and stage.
 * e.g. https://eu-west-1.s3.fil.one (production). Non-production stages talk to
 * each operator's own hostname directly rather than through a `fil.one` name.
 */
export function getS3Endpoint(region: S3Region, stage: Stage | string): string {
  //TODO change this when aurora supports staging URL structure through our DNS.
  if (stage != Stage.Production) {
    switch (region) {
      case S3Region.EuWest1:
        return 'https://s3.dev.aur.lu';
      case S3Region.UsEast1:
        return 'https://us-east-1.fortilyx.com';
      case S3Region.EuCentral3:
        return 'https://ingot.staging.fil.one';
    }
  }
  return `https://${region}.${PROD_DATA_DOMAIN_BY_REGION[region]}`;
}

/**
 * Every S3 origin the console may need to reach, for CSP `connect-src`.
 *
 * CSP is a single static document header that cannot vary per user, so it has to
 * cover every regional endpoint any user could reach. In production that means
 * both data domains for the duration of the migration: presigned URLs sign the
 * `Host` header, so one minted just before a region flipped stays valid on the
 * old host and a page holding it may still retry the request.
 *
 * Drop {@link LEGACY_DATA_DOMAIN} from this list once every region has flipped
 * and the deprecation window has elapsed — see MAX_GET_OBJECT_EXPIRY_SECONDS,
 * the longest a presigned URL can outlive the flip that replaced it.
 */
export function getS3CspOrigins(stage: Stage | string): string[] {
  const regions = Object.values(S3Region);
  if (stage !== Stage.Production) {
    return [...new Set(regions.map((region) => getS3Endpoint(region, stage)))];
  }
  const domains = [CONTENT_DATA_DOMAIN, LEGACY_DATA_DOMAIN];
  return regions.flatMap((region) => domains.map((domain) => `https://${region}.${domain}`));
}

/**
 * Auth0 tenant domain used by the deployment for user authentication.
 *
 * Production uses a custom domain (`auth.fil.one`); all other stages —
 * staging, per-PR previews, personal dev — share the dev tenant.
 */
export function getAuth0Domain(stage: Stage | string): string {
  return stage === Stage.Production ? 'auth.fil.one' : 'dev-oar2nhqh58xf5pwf.us.auth0.com';
}

/**
 * Infer the deployment stage from the hostname a deployment is served on.
 *
 * The production website is the only deployment served from `app.fil.one`;
 * staging, per-PR previews and personal dev all share a non-production
 * Auth0 tenant and are treated as {@link Stage.Staging} for the purposes
 * of stage-derived config (Auth0 domain, S3 endpoint, etc.).
 */
export function getStageFromHostname(hostname: string): Stage {
  return hostname === 'app.fil.one' ? Stage.Production : Stage.Staging;
}

/** Cookie name for the OAuth state parameter (CSRF protection for login flow). */
export const OAUTH_STATE_COOKIE = 'hs_oauth_state';

/** Cookie name for the CSRF double-submit token. */
export const CSRF_COOKIE_NAME = 'hs_csrf_token';

/** Number of bytes in a Gigabyte (1000^3). */
export const GB_BYTES = 1_000_000_000;

/** Number of bytes in a Terabyte (1000^4). */
export const TB_BYTES = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Usage limits — single source of truth for trial vs paid plan limits
// ---------------------------------------------------------------------------

/** Trial: 1 TB storage, 2 TB egress. Paid: unlimited (-1). */
export const TRIAL_STORAGE_LIMIT = 1 * TB_BYTES;
export const TRIAL_EGRESS_LIMIT = 2 * TB_BYTES;
export const TRIAL_DURATION_DAYS = 30;
export const TRIAL_GRACE_DAYS = 7;
export const PAID_GRACE_DAYS = 30;
export const UNLIMITED = -1;

export interface UsageLimits {
  storageLimitBytes: number; // -1 = unlimited
  egressLimitBytes: number; // -1 = unlimited
}

/** Derive storage & egress limits from whether the user has an active paid subscription. */
export function getUsageLimits(isActivePaid: boolean): UsageLimits {
  if (isActivePaid) {
    return { storageLimitBytes: UNLIMITED, egressLimitBytes: UNLIMITED };
  }
  return { storageLimitBytes: TRIAL_STORAGE_LIMIT, egressLimitBytes: TRIAL_EGRESS_LIMIT };
}
