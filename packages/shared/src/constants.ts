/** Deployment stages. */
export enum Stage {
  Production = 'production',
  Staging = 'staging',
}

export const DOCS_URL = 'https://fil.one/docs';

/** Available S3 regions. */
export enum S3Region {
  EuWest1 = 'eu-west-1',
}

/** Default S3 region for Fil One. */
export const S3_REGION = S3Region.EuWest1;

/**
 * Build the S3-compatible endpoint URL for a given region and stage.
 * e.g. https://eu-west-1.s3.fil.one (production) or https://eu-west-1.s3.staging.fil.one (non-prod).
 */
export function getS3Endpoint(region: S3Region, stage: Stage | string): string {
  //TODO change this when aurora supports staging URL structure through our DNS.
  if (stage != Stage.Production) {
    return 'https://s3.dev.aur.lu';
  }
  const base = 's3.fil.one';
  // const base = stage === Stage.Production ? 's3.fil.one' : 's3.staging.fil.one';
  return `https://${region}.${base}`;
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
