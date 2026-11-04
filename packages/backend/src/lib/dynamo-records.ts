import { S3Region } from '@filone/shared';
import type {
  AccessKeyBucketScope,
  AccessKeyPermission,
  BulkDeleteFailure,
  BulkDeleteJobStatus,
  BulkDeleteScope,
  GranularPermission,
  SubscriptionStatus,
} from '@filone/shared';
import type Stripe from 'stripe';

/**
 * The era a key was minted in.
 *
 * `pre-member-scope` records one fact: the key was created after the role
 * vocabulary existed and before member bucket scope is enforced. It does not
 * claim a cap was applied — the permission cap ships with enforcement, and
 * bucket scope does not exist until FIL-1017, whose keys get the next value in
 * this union. Keys older than roles carry no marker at all, and both cohorts
 * are what the non-conforming-key review has to find. None of it is
 * backfillable, which is why the marker ships now rather than with the surfaces
 * that read it.
 */
export type AccessKeyPolicyVersion = 'pre-member-scope';

export const ACCESS_KEY_POLICY_VERSION: AccessKeyPolicyVersion = 'pre-member-scope';

/**
 * Every key an access-key row is addressed by, in one builder.
 *
 * The handlers built these strings by hand in five places, which is how a
 * mint and a revoke end up disagreeing about where a key lives.
 */
const ACCESS_KEY_SK_PREFIX = 'ACCESSKEY#';

export const AccessKeyKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  keySk: (keyId: string): string => `${ACCESS_KEY_SK_PREFIX}${keyId}`,
  /** For the Query that lists an org's keys. */
  keySkPrefix: (): string => ACCESS_KEY_SK_PREFIX,
} as const;

/**
 * The region of an access-key row that carries no `region` attribute. Those
 * rows were written before multi-region routing, so they predate FTH and
 * belong to Aurora.
 */
export const DEFAULT_ACCESS_KEY_REGION: S3Region = S3Region.EuWest1;

/** UserInfoTable — pk: ORG#{orgId}, sk: ACCESSKEY#{id} */
export interface AccessKeyRecord {
  pk: string;
  sk: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status: string;
  /**
   * The region whose orchestrator holds the credential. Absent on rows written
   * before multi-region routing, which predate FTH and belong to Aurora.
   */
  region?: S3Region;
  /**
   * What the key carries. This stamp is the only record of it: the orchestrator
   * interface reads no permissions back, so nothing at the vendor can be
   * compared against it. Absent on a `recovered` row, which the console never
   * learned the shape of.
   */
  permissions?: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
  bucketScope?: AccessKeyBucketScope;
  buckets?: string[];
  /**
   * The member this key is bound to, on a region serving the `iam` access
   * model. Such a key carries no authority of its own; bucket policies decide.
   * Always the same as `createdBy` today; kept apart because it is what the
   * storage system knows the key by.
   */
  principalId?: string;
  expiresAt?: string;
  /** The FilOne user who minted the key. Absent on keys older than roles. */
  createdBy?: string;
  /** The creator's verified email at creation time, for display without a join. */
  creatorEmail?: string;
  /** See {@link AccessKeyPolicyVersion}. */
  policyVersion?: AccessKeyPolicyVersion;
  /**
   * Set when the row was reconstructed from the provider after a partial
   * failure, so its attribution names the caller who retried rather than a
   * confirmed creator. See `recoverDuplicateKey`.
   */
  recovered?: boolean;
  /**
   * The name this key answers to at the vendor, when that is not `keyName`.
   *
   * Key names are unique per tenant and no orchestrator can rename one, so a
   * rotation cannot reuse the console name while the key it replaces still
   * holds it. The replacement is minted under a suffixed name and the console
   * goes on showing the name its owner chose. Absent on a key that was never
   * rotated, where the two are the same string.
   *
   * Nothing on a request path reads it. It is here so an operator chasing a
   * credential can find it at the vendor, where it does not answer to the name
   * the console shows.
   */
  vendorKeyName?: string;
  /**
   * The id of the key that replaced this one, written in the same transaction
   * as the replacement's row. It is the claim that keeps two rotations of one
   * key from both landing: the second finds it set and refuses. It survives
   * only on a row whose revoke then failed, which the list still shows and the
   * owner can still delete.
   */
  replacedBy?: string;
  /**
   * Who last rotated the key and when. Kept apart from `createdBy`, which stays
   * with the owner across a rotation: an Admin reissuing a member's credential
   * is recorded here, and the owner's list still shows the key as theirs.
   */
  rotatedBy?: string;
  rotatedAt?: string;
}

/**
 * Who minted a key and under what policy, for the row's attribution
 * attributes. The email is verified-only: an unverified address must never be
 * the name attached to a credential.
 */
export function keyAttribution({
  userId,
  creatorEmail,
}: {
  userId: string;
  creatorEmail?: string;
}): Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'> {
  return {
    createdBy: userId,
    ...(creatorEmail ? { creatorEmail } : {}),
    policyVersion: ACCESS_KEY_POLICY_VERSION,
  };
}

/**
 * The Stripe price a subscription is billed on. Only fields that are immutable
 * on a Stripe price are kept — mutable ones (`nickname`, `active`, `metadata`,
 * `lookup_key`) are dropped, so a copy of this shape can never drift from
 * Stripe no matter how long we hold it. The plan display name is the one
 * exception, see below. Field names mirror the Stripe API.
 */
export interface StripePriceDetails {
  id: string;
  product?: string;
  /**
   * The customer-facing plan name, read from the product's `display_name`
   * metadata and cached alongside the price so a Stripe outage does not cost
   * the customer the name of their own plan. Unlike the rest of this shape it
   * can change in Stripe, so the cache is also rewritten when it does.
   * Snake_case with the rest of this interface, which mirrors Stripe's field
   * names.
   */
  plan_display_name?: string;
  currency?: string;
  /**
   * Stripe may add values to these enums at any time. The pricing code reports
   * neither a minimum nor a rate for a value it does not know.
   */
  billing_scheme?: Stripe.Price.BillingScheme;
  tiers_mode?: Stripe.Price.TiersMode | null;
  unit_amount?: number | null;
  /** Set instead of `unit_amount` for sub-cent rates, e.g. '0.499' per GB. */
  unit_amount_decimal?: string | null;
  tiers?: Array<{
    up_to: number | null;
    flat_amount: number | null;
    flat_amount_decimal: string | null;
    unit_amount: number | null;
    unit_amount_decimal: string | null;
  }>;
  recurring?: {
    interval?: string;
    interval_count?: number;
    usage_type?: string;
    meter?: string | null;
  } | null;
}

/**
 * BillingTable — pk: `ORG#{orgId}`, sk: SUBSCRIPTION (ADR §5). Read and written
 * through `lib/subscription-store.ts`, never keyed inline.
 */
export interface SubscriptionRecord {
  pk: string;
  sk: string;
  /**
   * The org the subscription belongs to — the partition key, and required.
   * One org, one subscription: a row without this is not addressable, which is
   * why the re-key's verification enumerated every such row and had each
   * dispositioned by name before the flip merged.
   */
  orgId: string;
  /**
   * The member who owns the Stripe customer. An attribute rather than part of
   * the key, so the self-healing paths that close out a deleted Stripe customer
   * still have a user to name.
   */
  userId?: string;
  stripeCustomerId?: string;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionId?: string;
  trialEndsAt?: string;
  gracePeriodEndsAt?: string;
  /** The billing period the meter reports against; written with the period end. */
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  /**
   * The deletion teardown's revive fence, an ISO timestamp the scrub stamps
   * with `if_not_exists`. Every guarded subscription writer refuses a row
   * carrying it (`attribute_not_exists(deletedAt)` via `guardAgainstScrub`),
   * so a late webhook cannot revive a scrubbed org.
   */
  deletedAt?: string;
  lastPaymentFailedAt?: string;
  /**
   * What `hubspot-contact-sync` knows about this row's HubSpot contact.
   *
   * `hubspotSyncedAt` is when the job last attempted the row, whatever came of
   * it, and is what its scan filter gates on — so a contact HubSpot cannot
   * match waits out the re-verify window like any other rather than being
   * retried on every run. `hubspotSubscriptionStatus` is the value HubSpot
   * confirmed holding, absent when it holds no contact for this user; the job
   * selects on it disagreeing with `subscriptionStatus` to repair a dropped
   * live write.
   */
  hubspotSubscriptionStatus?: SubscriptionStatus;
  hubspotSyncedAt?: string;
  paymentMethodId?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  paymentMethodExpMonth?: number;
  paymentMethodExpYear?: number;
  /**
   * Cached so we can still report what the customer pays when the Stripe API is
   * unavailable. Rewritten only when the price id changes.
   */
  stripePrice?: StripePriceDetails;
  updatedAt?: string;
}

/**
 * A user-initiated bulk deletion of a bucket's objects, resumable across Lambda
 * invocations: the worker persists its listing cursor whenever it runs out of
 * time budget, then re-invokes itself and picks up where it stopped.
 *
 * `jobId` is the caller's idempotency key, so a retried create resolves to the
 * same row and a conditional put is all the protection needed against a double
 * submit starting a second deletion.
 *
 * BulkDeleteTable — pk: BULKDELETE#{orgId}, sk: JOB#{jobId}
 */
export interface BulkDeleteJobRecord {
  pk: string;
  sk: string;
  jobId: string;
  orgId: string;
  region: S3Region;
  bucketName: string;
  /** Empty string means the whole bucket. */
  prefix: string;
  scope: BulkDeleteScope;
  /**
   * The user who started the job. The worker re-reads their role, and for a
   * scoped member their bucket access, before each run. Absent on jobs queued
   * before it was recorded.
   */
  startedBy?: string;
  status: BulkDeleteJobStatus;
  deletedCount: number;
  failedCount: number;
  /** Bounded sample; `failedCount` is the authoritative total. */
  failures: BulkDeleteFailure[];
  /** Listing resume point; absent once the walk is exhausted. */
  cursor?: BulkDeleteCursorRecord;
  /**
   * Hand-offs made so far. Doubles as the deduplication id of the job's next
   * queue message, so it must be persisted before that message is sent.
   */
  resumeCount?: number;
  startedAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  completedAt?: string; // ISO-8601
  /** Present when status is `failed`. */
  error?: string;
  ttl: number; // epoch seconds; DynamoDB TTL expiry
}

/** Persisted form of the S3 listing cursor (see s3-bulk-delete). */
export interface BulkDeleteCursorRecord {
  continuationToken?: string;
  keyMarker?: string;
  versionIdMarker?: string;
}

export const BulkDeleteKeys = {
  jobPk: (orgId: string): string => `BULKDELETE#${orgId}`,
  jobSk: (jobId: string): string => `JOB#${jobId}`,
} as const;
