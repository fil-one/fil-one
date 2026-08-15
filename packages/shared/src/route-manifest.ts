import type { Permission } from './permissions.js';

/**
 * Every API route, its authentication category, and what it requires of the
 * caller. Declared rather than implied so route coverage is machine-checkable:
 * a backend test walks `packages/backend/src/handlers/` and fails on any
 * handler missing from this manifest, which makes "we forgot to gate the new
 * route" a red build instead of an open door.
 *
 * The manifest is the source of truth for what `authorize()` installs; it does
 * not itself enforce anything.
 */
export type RouteCategory =
  /** Cookie session resolved by `authMiddleware`; carries a requirement below. */
  | 'authenticated'
  /** No session — the Auth0 login round trip. */
  | 'public'
  /** No Middy chain; authenticated by the provider's request signature. */
  | 'webhook'
  /** RAG bearer token resolved by `ragQueryAuthMiddleware`, which bypasses
   * `authMiddleware` entirely on that branch and resolves the key creator's
   * membership itself. The same route still accepts a cookie session when no
   * `Authorization` header is present. */
  | 'bearer';

/**
 * What an authenticated route asks of the caller.
 *
 * A {@link Permission} is checked against the caller's role before the handler
 * runs. `'self'` marks routes that only touch the caller's own account —
 * profile, preferences, MFA — where membership in the active org is the whole
 * requirement and no role gate applies. `'in-handler'` marks routes whose
 * requirement depends on the request body, checked against this same registry
 * inside the handler.
 */
export type RouteRequirement = Permission | 'self' | 'in-handler';

export interface RouteManifestEntry {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** API Gateway route path, as passed to `addRoute` in sst.config.ts. */
  path: string;
  /** Handler module under `packages/backend/src/handlers/`, without extension. */
  handler: string;
  category: RouteCategory;
  /** Set on `authenticated` routes, absent on every other category. */
  requires?: RouteRequirement;
}

export const ROUTE_MANIFEST = [
  // ── Buckets ──────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/buckets',
    handler: 'list-buckets',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  {
    method: 'POST',
    path: '/api/buckets',
    handler: 'create-bucket',
    category: 'authenticated',
    requires: 'buckets.create',
  },
  {
    method: 'GET',
    path: '/api/buckets/{name}',
    handler: 'get-bucket',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  {
    method: 'DELETE',
    path: '/api/buckets/{name}',
    handler: 'delete-bucket',
    category: 'authenticated',
    requires: 'buckets.delete',
  },
  {
    method: 'GET',
    path: '/api/buckets/{name}/analytics',
    handler: 'get-bucket-analytics',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  {
    method: 'GET',
    path: '/api/buckets/{name}/rag/enabled',
    handler: 'get-bucket-rag-enablement',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  // Turning indexing on for a bucket is a bucket-configuration write, so it
  // sits with bucket creation rather than with object writes.
  {
    method: 'POST',
    path: '/api/buckets/{name}/rag/enabled',
    handler: 'set-bucket-rag-enablement',
    category: 'authenticated',
    requires: 'buckets.create',
  },

  // ── Objects ──────────────────────────────────────────────────────
  // One route serves read, write, and delete presigns, so the check branches
  // per requested operation next to the existing trial checks. A batch with any
  // denied operation is rejected whole.
  {
    method: 'POST',
    path: '/api/presign',
    handler: 'presign',
    category: 'authenticated',
    requires: 'in-handler',
  },

  // ── Keys ─────────────────────────────────────────────────────────
  // Listing and revoking are `keys.manage_own`; reaching another member's key
  // additionally needs `keys.manage_all`, which the handlers check once keys
  // carry a creator (M2).
  {
    method: 'GET',
    path: '/api/access-keys',
    handler: 'list-access-keys',
    category: 'authenticated',
    requires: 'keys.manage_own',
  },
  {
    method: 'POST',
    path: '/api/access-keys',
    handler: 'create-access-key',
    category: 'authenticated',
    requires: 'keys.create',
  },
  {
    method: 'DELETE',
    path: '/api/access-keys/{keyId}',
    handler: 'delete-access-key',
    category: 'authenticated',
    requires: 'keys.manage_own',
  },
  {
    method: 'GET',
    path: '/api/rag-api-keys',
    handler: 'list-rag-api-keys',
    category: 'authenticated',
    requires: 'keys.manage_own',
  },
  {
    method: 'POST',
    path: '/api/rag-api-keys',
    handler: 'create-rag-api-key',
    category: 'authenticated',
    requires: 'keys.create',
  },
  {
    method: 'DELETE',
    path: '/api/rag-api-keys/{keyId}',
    handler: 'delete-rag-api-key',
    category: 'authenticated',
    requires: 'keys.manage_own',
  },

  // ── RAG query ────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/buckets/{name}/query',
    handler: 'query-bucket',
    category: 'bearer',
  },

  // ── Auth ─────────────────────────────────────────────────────────
  { method: 'GET', path: '/login', handler: 'auth-login', category: 'public' },
  { method: 'GET', path: '/api/auth/callback', handler: 'auth-callback', category: 'public' },
  { method: 'GET', path: '/logout', handler: 'auth-logout', category: 'public' },

  // ── Account ──────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/me',
    handler: 'get-me',
    category: 'authenticated',
    requires: 'self',
  },
  // Self-service profile fields, except that the same body can rename the org —
  // that field needs `org.rename`, which the handler checks when it is present.
  {
    method: 'PATCH',
    path: '/api/me/profile',
    handler: 'update-profile',
    category: 'authenticated',
    requires: 'in-handler',
  },
  {
    method: 'POST',
    path: '/api/me/change-password',
    handler: 'change-password',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'GET',
    path: '/api/me/preferences',
    handler: 'get-preferences',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'PATCH',
    path: '/api/me/preferences',
    handler: 'update-preferences',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'POST',
    path: '/api/me/resend-verification',
    handler: 'resend-verification',
    category: 'authenticated',
    requires: 'self',
  },

  // ── MFA ──────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/mfa/enroll',
    handler: 'enroll-mfa',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'POST',
    path: '/api/mfa/disable',
    handler: 'disable-mfa',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'DELETE',
    path: '/api/mfa/enrollments/{enrollmentId}',
    handler: 'delete-mfa-enrollment',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'POST',
    path: '/api/mfa/recovery-code/regenerate',
    handler: 'regenerate-recovery-code',
    category: 'authenticated',
    requires: 'self',
  },
  {
    method: 'DELETE',
    path: '/api/mfa/passkeys/{methodId}',
    handler: 'delete-passkey',
    category: 'authenticated',
    requires: 'self',
  },

  // ── Usage and activity ───────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/usage',
    handler: 'get-usage',
    category: 'authenticated',
    requires: 'billing.view',
  },
  {
    method: 'GET',
    path: '/api/usage/trends',
    handler: 'get-usage-trends',
    category: 'authenticated',
    requires: 'billing.view',
  },
  // A synthesized feed of bucket, object, and key events — not the audit log.
  {
    method: 'GET',
    path: '/api/activity',
    handler: 'get-activity',
    category: 'authenticated',
    requires: 'buckets.read',
  },

  // ── Billing ──────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/billing',
    handler: 'get-billing',
    category: 'authenticated',
    requires: 'billing.view',
  },
  {
    method: 'GET',
    path: '/api/billing/invoices',
    handler: 'list-invoices',
    category: 'authenticated',
    requires: 'billing.view',
  },
  {
    method: 'POST',
    path: '/api/billing/setup-intent',
    handler: 'create-setup-intent',
    category: 'authenticated',
    requires: 'billing.manage',
  },
  {
    method: 'POST',
    path: '/api/billing/activate',
    handler: 'activate-subscription',
    category: 'authenticated',
    requires: 'billing.manage',
  },
  {
    method: 'POST',
    path: '/api/billing/portal',
    handler: 'create-portal-session',
    category: 'authenticated',
    requires: 'billing.manage',
  },

  // ── Webhooks ─────────────────────────────────────────────────────
  { method: 'POST', path: '/api/stripe/webhook', handler: 'stripe-webhook', category: 'webhook' },
] as const satisfies readonly RouteManifestEntry[];
