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
}

/** Default S3 region for Fil One. */
export const S3_REGION = S3Region.EuWest1 satisfies S3Region;

/** Human-readable region labels. */
export const REGION_LABELS: Record<S3Region, string> = {
  [S3Region.EuWest1]: 'Europe (France)',
  [S3Region.UsEast1]: 'US East (Michigan)',
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

/** Filecoin Foundation email domain, allowlisted for early-access regions. */
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
 * Regions selectable in the given stage. Non-production stages expose
 * `us-east-1` for dogfooding; in production it is additionally exposed to
 * Filecoin Foundation users (verified `@fil.org` emails) for early access.
 * `email` should be passed only when verified — see {@link isFoundationEmail}.
 */
export function getAvailableRegions(stage: Stage | string, email?: string): S3Region[] {
  if (stage !== Stage.Production || isFoundationEmail(email)) {
    return [S3Region.EuWest1, S3Region.UsEast1];
  }
  return [S3Region.EuWest1];
}

/**
 * Checks if the region is supported in the given stage (optionally for a
 * specific verified user email — see {@link getAvailableRegions}).
 * Provides type-narrowing information to TypeScript, changing `region`
 * from `string` to `S3Region` when the function returns `true`.
 */
export function isSupportedRegion(
  stage: Stage | string,
  region: string,
  email?: string,
): region is S3Region {
  return getAvailableRegions(stage, email).includes(region as S3Region);
}

/**
 * Build the S3-compatible endpoint URL for a given region and stage.
 * e.g. https://eu-west-1.s3.fil.one (production) or https://eu-west-1.s3.staging.fil.one (non-prod).
 */
export function getS3Endpoint(region: S3Region, stage: Stage | string): string {
  //TODO change this when aurora supports staging URL structure through our DNS.
  if (stage != Stage.Production) {
    switch (region) {
      case S3Region.EuWest1:
        return 'https://s3.dev.aur.lu';
      case S3Region.UsEast1:
        return 'https://us-east-1.fortilyx.com';
    }
  }
  const base = 's3.fil.one';
  // const base = stage === Stage.Production ? 's3.fil.one' : 's3.staging.fil.one';
  return `https://${region}.${base}`;
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
