export { buildAuth0AuthorizeUrl } from './auth.js';
export type { Auth0LoginUrlOptions } from './auth.js';

export {
  Stage,
  DOCS_URL,
  S3_REGION,
  S3Region,
  getS3Endpoint,
  getAuth0Domain,
  getStageFromHostname,
  OAUTH_STATE_COOKIE,
  CSRF_COOKIE_NAME,
  GB_BYTES,
  TB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  TRIAL_GRACE_DAYS,
  PAID_GRACE_DAYS,
  UNLIMITED,
  getUsageLimits,
} from './constants.js';
export type { UsageLimits } from './constants.js';
export { formatBytes, formatBytesShort } from './formatBytes.js';
export type {
  MeResponse,
  ConfirmOrgRequest,
  ConfirmOrgResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
} from './api/me.js';
export { UpdateProfileSchema } from './api/me.js';

export { getProvider, isSocialConnection } from './connection-providers.js';
export type { ConnectionProvider } from './connection-providers.js';
export {
  OrgRole,
  OrgNameSchema,
  ConfirmOrgSchema,
  ORG_NAME_MIN_LENGTH,
  ORG_NAME_MAX_LENGTH,
  ORG_NAME_PATTERN,
  ORG_NAME_DISALLOWED_CHARS,
} from './api/org.js';
export { ApiErrorCode } from './api/coreInterfaces.js';
export type { ErrorResponse } from './api/coreInterfaces.js';

export type {
  Bucket,
  ListBucketsResponse,
  CreateBucketRequest,
  CreateBucketResponse,
  GetBucketResponse,
  DeleteBucketRequest,
  BucketAnalyticsResponse,
} from './api/buckets.js';

export {
  BUCKET_NAME_MIN_LENGTH,
  BUCKET_NAME_MAX_LENGTH,
  BUCKET_NAME_PATTERN,
  RETENTION_MODES,
  RETENTION_DURATION_TYPES,
  RETENTION_MAX_DAYS,
  RETENTION_MAX_YEARS,
  CreateBucketSchema,
} from './api/buckets.js';

export type { RetentionMode, RetentionDurationType } from './api/buckets.js';

export type {
  S3Object,
  S3ObjectVersion,
  ListObjectsRequest,
  ListObjectsResponse,
  ListObjectVersionsResponse,
  DeleteObjectRequest,
  ObjectMetadataResponse,
  ObjectRetentionInfo,
} from './api/objects.js';

export type {
  PresignOp,
  PresignRequest,
  PresignHttpMethod,
  PresignResponseItem,
  PresignResponse,
} from './api/presign.js';

export { PresignOpSchema, PresignRequestSchema } from './api/presign.js';

export {
  ACCESS_KEY_PERMISSIONS,
  ACCESS_KEY_BUCKET_SCOPES,
  GRANULAR_PERMISSIONS,
  GRANULAR_PERMISSION_MAP,
  GRANULAR_PERMISSION_LABELS,
  KEY_NAME_MAX_LENGTH,
  KEY_NAME_PATTERN,
  CreateAccessKeySchema,
} from './api/access-keys.js';
export type {
  AccessKeyStatus,
  AccessKeyPermission,
  AccessKeyBucketScope,
  GranularPermission,
  AccessKey,
  ListAccessKeysResponse,
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  DeleteAccessKeyRequest,
} from './api/access-keys.js';

export type {
  UsageDataPoint,
  UsageTrendsRequest,
  UsageTrendsResponse,
  BucketActivity,
  ObjectActivity,
  KeyActivity,
  RecentActivity,
  RecentActivityResponse,
  ActivityResponse,
} from './api/dashboard.js';

export type { UsageResponse } from './api/usage.js';

export { PlanId, SubscriptionStatus, mapStripeStatus } from './api/billing.js';
export type {
  Plan,
  Subscription,
  PaymentMethod,
  BillingInfo,
  CreateSetupIntentResponse,
  ActivateSubscriptionResponse,
  CreatePortalSessionResponse,
  Invoice,
  ListInvoicesResponse,
} from './api/billing.js';
