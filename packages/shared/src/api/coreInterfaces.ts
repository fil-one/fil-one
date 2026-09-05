/** Centralised catalogue of every custom error code the API can return. */
export enum ApiErrorCode {
  /** Subscription is in a grace period — write operations are blocked. */
  GRACE_PERIOD_WRITE_BLOCKED = 'GRACE_PERIOD_WRITE_BLOCKED',
  /** Subscription has been canceled — all access is blocked. */
  SUBSCRIPTION_CANCELED = 'SUBSCRIPTION_CANCELED',
  /** Subscription is in an inactive or incomplete state — all access is blocked. */
  SUBSCRIPTION_INACTIVE = 'SUBSCRIPTION_INACTIVE',
  /**
   * The active organization has no subscription, and the caller is not the
   * person who can create one. Distinct from SUBSCRIPTION_INACTIVE, which tells
   * the account holder to fix their own payment method.
   */
  ORG_BILLING_INACTIVE = 'ORG_BILLING_INACTIVE',
  /** Promo code is invalid, expired, or inactive. */
  INVALID_PROMOTION_CODE = 'INVALID_PROMOTION_CODE',
  /** Trial accounts cannot generate presigned URLs — upgrade required. */
  TRIAL_PRESIGN_BLOCKED = 'TRIAL_PRESIGN_BLOCKED',
  /** The authenticated user's email address has not been verified. */
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  /** The email domain is a known disposable/temporary address provider. */
  DISPOSABLE_EMAIL_BLOCKED = 'DISPOSABLE_EMAIL_BLOCKED',
  /** The bucket's first indexing pass has not completed — RAG queries are unavailable. */
  BUCKET_NOT_INDEXED = 'BUCKET_NOT_INDEXED',
  /** The bucket still holds objects or object versions — it must be emptied before deletion. */
  BUCKET_NOT_EMPTY = 'BUCKET_NOT_EMPTY',
  /** The submitted account-deletion code does not match the issued one. */
  DELETION_CODE_INVALID = 'DELETION_CODE_INVALID',
  /** The account-deletion code has expired or its attempt budget is spent. */
  DELETION_CODE_EXPIRED_OR_LOCKED = 'DELETION_CODE_EXPIRED_OR_LOCKED',
  /** Too many account-deletion codes requested — retry after `resendAvailableAt`. */
  DELETION_RATE_LIMITED = 'DELETION_RATE_LIMITED',
  /** The account has been deleted; the session is dead and cannot be revived. */
  ACCOUNT_DELETED = 'ACCOUNT_DELETED',
  /** The caller's role in the active organization does not carry this permission. */
  FORBIDDEN_ROLE = 'FORBIDDEN_ROLE',
  /** The caller is not a member of the organization the request names. */
  NOT_A_MEMBER = 'NOT_A_MEMBER',
  /** The invitation was issued to a different email address than the session's. */
  INVITE_EMAIL_MISMATCH = 'INVITE_EMAIL_MISMATCH',
  /**
   * The token resolves to no usable invitation. One code for expired, revoked,
   * already accepted, and never existed: the accept page says the link is no
   * longer good and offers to ask for a new one, and telling the four apart
   * would describe other people's invitations to whoever holds a stale link.
   */
  INVITE_NOT_FOUND = 'INVITE_NOT_FOUND',
  /**
   * The org already has as many pending invitations as it may hold. The cap is
   * the only rate limit on the invite path, so this is a routine answer rather
   * than an incident: revoking or accepting one frees a slot.
   */
  INVITE_LIMIT_REACHED = 'INVITE_LIMIT_REACHED',
  /**
   * Issuing invitations is not switched on for this organization yet. Its own
   * code because the console renders it as a state of the form rather than a
   * failed attempt, and the alternative — recognising it by the absence of a
   * code — collects every other code-less 403 with it, CSRF expiry included.
   */
  INVITES_NOT_ENABLED = 'INVITES_NOT_ENABLED',
  /**
   * The change would leave the organization with no Owner. Its own code because
   * the console's remedy is specific — promote somebody first, or transfer
   * ownership — and a generic conflict would send the user to support.
   */
  LAST_OWNER = 'LAST_OWNER',
  /**
   * The audit export matched more than one response can carry. Its own code
   * because the remedy is specific and the console can act on it: narrow the
   * date range, or filter to one event type or one member. Refused rather than
   * truncated — a short export that does not say it is short is worse than no
   * export.
   */
  AUDIT_EXPORT_TOO_LARGE = 'AUDIT_EXPORT_TOO_LARGE',
}

export interface ErrorResponse {
  message?: string;
  code?: ApiErrorCode;
}
