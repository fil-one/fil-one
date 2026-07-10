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
  /** The submitted account-deletion verification code does not match. */
  DELETION_CODE_INVALID = 'DELETION_CODE_INVALID',
  /** The deletion code expired or too many attempts were made — request a new one. */
  DELETION_CODE_EXPIRED_OR_LOCKED = 'DELETION_CODE_EXPIRED_OR_LOCKED',
  /** Too many deletion codes requested — wait for the cooldown. */
  DELETION_RATE_LIMITED = 'DELETION_RATE_LIMITED',
  /** The authenticated account has been deleted. */
  ACCOUNT_DELETED = 'ACCOUNT_DELETED',
}

export interface ErrorResponse {
  message?: string;
  code?: ApiErrorCode;
}
