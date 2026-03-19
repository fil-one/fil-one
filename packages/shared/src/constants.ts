/** S3-compatible storage endpoint for Fil One. */
export const S3_ENDPOINT = 'https://s3.fil.one';

/** S3 region for Fil One. */
export const S3_REGION = 'eu-west-1';

/** Cookie name for the OAuth state parameter (CSRF protection for login flow). */
export const OAUTH_STATE_COOKIE = 'hs_oauth_state';

/** Cookie name for the CSRF double-submit token. */
export const CSRF_COOKIE_NAME = 'hs_csrf_token';

/** Number of bytes in a Terabyte (1000^4). */
export const TB_BYTES = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Usage limits — single source of truth for trial vs paid plan limits
// ---------------------------------------------------------------------------

/** Trial: 1 TB storage, 2 TB egress. Paid: unlimited (-1). */
export const TRIAL_STORAGE_LIMIT = 1 * TB_BYTES;
export const TRIAL_EGRESS_LIMIT = 2 * TB_BYTES;
export const TRIAL_DURATION_DAYS = 30;
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
