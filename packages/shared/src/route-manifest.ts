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
   * `authMiddleware` entirely on that branch and builds the caller from the key
   * record. That path resolves the key creator's membership itself, so a
   * revoked creator loses the key's authority. The same route still accepts a
   * cookie session when no `Authorization` header is present, and that caller
   * is gated on {@link RouteManifestEntry.cookieRequires}. */
  | 'bearer';

/**
 * What an authenticated route asks of the caller.
 *
 * A {@link Permission} is checked against the caller's role before the handler
 * runs. `'self'` marks routes that only touch the caller's own account —
 * profile, preferences, MFA — and carries no org gate at all: an authenticated
 * session is the whole requirement, because gating your own password on a role
 * would lock a ReadOnly member out of their own account. `'in-handler'` marks
 * routes whose permission depends on the request body; the chain gates them on
 * membership and the handler checks the permission against this same registry.
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
  /**
   * Set on `bearer` routes, which accept two kinds of caller. The bearer token
   * carries its own authority; a caller arriving with a cookie session instead
   * is an ordinary console user and holds this permission or is refused.
   */
  cookieRequires?: Permission;
  /**
   * Set on the routes whose chain installs `ragAccessMiddleware`. RAG is behind
   * a per-email allowlist while it is in early access, so those routes carry a
   * second gate on top of the role one: the caller reaches the handler from a
   * foundation address or from a row on the allowlist, and is refused
   * otherwise.
   */
  ragAllowlisted?: boolean;
}

const MANIFEST = [
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
    ragAllowlisted: true,
  },
  // Turning indexing on for a bucket is a bucket-configuration write, so it
  // sits with bucket creation rather than with object writes; turning it off
  // discards the index, which is destructive configuration and sits with bucket
  // deletion. The handler branches on the body: `enabled: true` needs
  // `buckets.create`, `enabled: false` needs `buckets.delete`.
  {
    method: 'POST',
    path: '/api/buckets/{name}/rag/enabled',
    handler: 'set-bucket-rag-enablement',
    category: 'authenticated',
    requires: 'in-handler',
    ragAllowlisted: true,
  },

  // ── Objects ──────────────────────────────────────────────────────
  // One route serves all seven presign operations, so the check branches per
  // requested operation next to the existing trial checks:
  //   getObject, headObject, listObjects, listObjectVersions → objects.read
  //   putObject                                              → objects.write
  //   deleteObject                                           → objects.delete
  //   getObjectRetention                                     → objects.read
  // A batch with any denied operation is rejected whole.
  //
  // getObjectRetention reads retention state rather than changing it, and the
  // PRD's auditor path grants exactly that read. A presign that mutates
  // retention or legal hold is a different matter: it is redeemed at the vendor
  // where its use cannot be logged, so if one is ever added it must be gated on
  // an explicit privileged grant rather than on a general object permission.
  {
    method: 'POST',
    path: '/api/presign',
    handler: 'presign',
    category: 'authenticated',
    requires: 'in-handler',
  },
  // Bulk deletion empties a bucket of every object and version, so starting a
  // job is the most destructive object write there is and takes
  // `objects.delete`. Reading a job's progress takes the same permission: the
  // job row is polled by the caller who started the deletion, nothing else
  // links to it, and a role that cannot delete has no reason to watch a
  // deletion run.
  {
    method: 'POST',
    path: '/api/buckets/{name}/bulk-delete',
    handler: 'create-bulk-delete-job',
    category: 'authenticated',
    requires: 'objects.delete',
  },
  {
    method: 'GET',
    path: '/api/bulk-delete-jobs/{jobId}',
    handler: 'get-bulk-delete-job',
    category: 'authenticated',
    requires: 'objects.delete',
  },

  // ── Keys ─────────────────────────────────────────────────────────
  // Listing and revoking are `keys.manage_all`, because no handler can yet tell
  // whose key it is holding: keys gain `createdBy` in this milestone, and until
  // a creator predicate exists, `keys.manage_own` would name a narrowing nobody
  // performs and hand a Member the whole org's key inventory. Relaxing list and
  // delete to `keys.manage_own` belongs to the change that adds that predicate.
  {
    method: 'GET',
    path: '/api/access-keys',
    handler: 'list-access-keys',
    category: 'authenticated',
    requires: 'keys.manage_all',
  },
  // `keys.create` is the entry gate, and the creator-authority cap runs in the
  // handler on top of it: the requested key permissions are intersected with the
  // creator's own, so a key can never carry more than the member minting it.
  {
    method: 'POST',
    path: '/api/access-keys',
    handler: 'create-access-key',
    category: 'authenticated',
    requires: 'in-handler',
  },
  {
    method: 'DELETE',
    path: '/api/access-keys/{keyId}',
    handler: 'delete-access-key',
    category: 'authenticated',
    requires: 'keys.manage_all',
  },
  {
    method: 'GET',
    path: '/api/rag-api-keys',
    handler: 'list-rag-api-keys',
    category: 'authenticated',
    requires: 'keys.manage_all',
    ragAllowlisted: true,
  },
  // A RAG key carries no permission vocabulary to intersect — it queries the
  // buckets its creator could query — so creation needs no in-handler cap.
  {
    method: 'POST',
    path: '/api/rag-api-keys',
    handler: 'create-rag-api-key',
    category: 'authenticated',
    requires: 'keys.create',
    ragAllowlisted: true,
  },
  {
    method: 'DELETE',
    path: '/api/rag-api-keys/{keyId}',
    handler: 'delete-rag-api-key',
    category: 'authenticated',
    requires: 'keys.manage_all',
    ragAllowlisted: true,
  },

  // ── RAG query ────────────────────────────────────────────────────
  // Dual auth: a bearer token authenticates itself, and the same route falls
  // back to the cookie session when no `Authorization` header is present. The
  // cookie caller is gated like any other read of bucket contents.
  {
    method: 'POST',
    path: '/api/buckets/{name}/query',
    handler: 'query-bucket',
    category: 'bearer',
    cookieRequires: 'buckets.read',
    ragAllowlisted: true,
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

  // ── Account deletion ─────────────────────────────────────────────
  // Deleting the account destroys the org, so both steps carry `org.delete`
  // rather than `self`; the FIL-112 stack's isOrgAdmin() gate folded into
  // this declaration when enforcement landed.
  {
    method: 'POST',
    path: '/api/account/deletion',
    handler: 'request-account-deletion',
    category: 'authenticated',
    requires: 'org.delete',
  },
  {
    method: 'POST',
    path: '/api/account/deletion/confirm',
    handler: 'confirm-account-deletion',
    category: 'authenticated',
    requires: 'org.delete',
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
  // Bytes stored and bytes served are storage telemetry, not payment data, and
  // the console fetches them on every page — gating them on `billing.view`
  // would leave a Member or ReadOnly staring at a blank console. Money lives
  // under /api/billing and keeps `billing.view`.
  {
    method: 'GET',
    path: '/api/usage',
    handler: 'get-usage',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  {
    method: 'GET',
    path: '/api/usage/trends',
    handler: 'get-usage-trends',
    category: 'authenticated',
    requires: 'buckets.read',
  },
  // A synthesized feed of bucket, object, and key events — not the audit log.
  // The route requirement is only half the gate: a feed carrying key-lifecycle
  // events has to drop them for a caller holding no `keys.*` permission, or it
  // hands a ReadOnly member the org's key inventory.
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

/**
 * The handler names the manifest actually declares. Infrastructure keyed by
 * handler (`ROUTE_INFRA_CONFIGS` in sst.config.ts) types its keys against this
 * union, so a key naming no route is a compile error instead of a route that
 * silently deploys without its IAM grants and environment.
 */
export type RouteHandler = (typeof MANIFEST)[number]['handler'];

/**
 * The manifest as an ordinary array of entries. Widened on purpose: consumers
 * read optional fields (`requires`, `cookieRequires`, `ragAllowlisted`) off
 * arbitrary elements, which the union of exact literal types does not permit.
 * The handler name is the one literal worth keeping, so it survives the
 * widening and anything keyed by handler can be checked against it.
 */
export const ROUTE_MANIFEST: readonly (RouteManifestEntry & { handler: RouteHandler })[] = MANIFEST;
