/** Centralised catalogue of every custom error code the API can return. */
export enum ApiErrorCode {
  /** User's organization has not been confirmed yet. Must complete onboarding. */
  ORG_NOT_CONFIRMED = 'ORG_NOT_CONFIRMED',
  /** Subscription is in a grace period — write operations are blocked. */
  GRACE_PERIOD_WRITE_BLOCKED = 'GRACE_PERIOD_WRITE_BLOCKED',
  /** Subscription has been canceled — all access is blocked. */
  SUBSCRIPTION_CANCELED = 'SUBSCRIPTION_CANCELED',
  /** Subscription is in an inactive or incomplete state — all access is blocked. */
  SUBSCRIPTION_INACTIVE = 'SUBSCRIPTION_INACTIVE',
}

export interface ErrorResponse {
  message?: string;
  code?: ApiErrorCode;
}
