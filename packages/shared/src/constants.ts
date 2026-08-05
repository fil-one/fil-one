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
      case S3Region.EuCentral3:
        return 'https://ingot.staging.fil.one';
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

/** Canonical hostname the production console is served on. */
export const PROD_CONSOLE_HOST = 'app.fil.one';

/**
 * Unlisted demo-alias hostnames the production console is also served on.
 *
 * These are alternate domain names on the same CloudFront distribution serving the
 * same bundle — not a separate deployment — and they are deliberately unadvertised.
 * The first entry is the ACM cert's primary domain, which is how sst.config.ts finds
 * the cert. See environments/prod/filone-ai.tf in fil-one/infrastructure, and
 * docs/Auth0OneTimeSetup.md §4a for the accepted mail-deliverability trade.
 */
export const PROD_CONSOLE_ALIAS_HOSTS = ['app.filone.ai'] as const;

/**
 * Marketing site to send a user to when they leave the console, keyed by the
 * console origin they arrived from.
 *
 * Signing out of an alias must not land the user on fil.one, which may be
 * blocklisted. A closed table rather than string surgery on the origin: these values
 * reach Auth0 as `returnTo`, so every possible result has to be one we chose, and
 * each must also appear in the client's allowed_logout_urls or Auth0 shows an error
 * instead of redirecting.
 */
export const MARKETING_URL_BY_CONSOLE_ORIGIN: Readonly<Record<string, string | undefined>> = {
  [`https://${PROD_CONSOLE_HOST}`]: 'https://fil.one',
  'https://app.filone.ai': 'https://filone.ai',
};

/**
 * Where to send a user after they sign out of the console served at `origin`.
 *
 * A production console hands off to its marketing site, and an alias hands off to the
 * alias marketing site rather than to fil.one, which may be blocklisted. Every other
 * stage returns to its own console, so switching the signed-in user on staging or a dev
 * stage leaves you on the stage you were testing instead of on production marketing.
 *
 * The result reaches Auth0 as `returnTo`, so every value this can produce must also
 * appear in the client's allowed_logout_urls; setup-auth0-client.ts derives them from
 * this same function so the two cannot drift.
 */
export function logoutReturnTo(origin: string): string {
  return MARKETING_URL_BY_CONSOLE_ORIGIN[origin] ?? origin;
}

/**
 * Auth0 domain to authenticate against, keyed by the console origin the request
 * arrived on. Production hosts only — non-production stages never match and fall
 * through to their configured domain.
 *
 * Aliases cannot use `auth.fil.one`: a second Auth0 custom domain requires an
 * Enterprise plan, and `auth.fil.one` sits on the same flagged TLD the aliases exist
 * to escape. They use the tenant's own domain, which stays available alongside a
 * custom domain. Consequences — passkeys and sessions do not carry between the two,
 * because the WebAuthn relying-party ID is the Auth0 hostname — are in
 * docs/Auth0OneTimeSetup.md §4a.
 */
export const AUTH0_DOMAIN_BY_CONSOLE_ORIGIN: Readonly<Record<string, string | undefined>> = {
  [`https://${PROD_CONSOLE_HOST}`]: 'auth.fil.one',
  'https://app.filone.ai': 'fil-one.us.auth0.com',
};

const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  PROD_CONSOLE_HOST,
  ...PROD_CONSOLE_ALIAS_HOSTS,
]);

/**
 * Infer the deployment stage from the hostname a deployment is served on.
 *
 * Production is served from {@link PROD_CONSOLE_HOST} and its demo aliases;
 * staging, per-PR previews and personal dev all share a non-production Auth0
 * tenant and are treated as {@link Stage.Staging} for the purposes of
 * stage-derived config (Auth0 domain, S3 endpoint, etc.).
 */
export function getStageFromHostname(hostname: string): Stage {
  return PRODUCTION_HOSTS.has(hostname.toLowerCase()) ? Stage.Production : Stage.Staging;
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
