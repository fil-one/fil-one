/** Centralised catalogue of every custom error code the API can return. */
export enum ApiErrorCode {
  /** Subscription is in a grace period — write operations are blocked. */
  GRACE_PERIOD_WRITE_BLOCKED = 'GRACE_PERIOD_WRITE_BLOCKED',
  /** Subscription has been canceled — all access is blocked. */
  SUBSCRIPTION_CANCELED = 'SUBSCRIPTION_CANCELED',
  /** Subscription is in an inactive or incomplete state — all access is blocked. */
  SUBSCRIPTION_INACTIVE = 'SUBSCRIPTION_INACTIVE',
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
}

export interface ErrorResponse {
  message?: string;
  code?: ApiErrorCode;
}
