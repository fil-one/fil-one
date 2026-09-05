export { buildAuth0AuthorizeUrl } from './auth.js';
export type { Auth0LoginUrlOptions } from './auth.js';

export {
  Stage,
  DOCS_URL,
  S3_REGION,
  S3Region,
  REGION_LABELS,
  FOUNDATION_EMAIL_DOMAIN,
  isFoundationEmail,
  formatRegion,
  getRegionLabel,
  getAvailableRegions,
  isSupportedRegion,
  supportsBucketManagement,
  getRegionAccessModel,
  getS3Endpoint,
  getAuth0Domain,
  getStageFromHostname,
  PROD_CONSOLE_HOST,
  PROD_CONSOLE_ALIAS_HOSTS,
  MARKETING_URL_BY_CONSOLE_ORIGIN,
  logoutReturnTo,
  AUTH0_DOMAIN_BY_CONSOLE_ORIGIN,
  OAUTH_STATE_COOKIE,
  CSRF_COOKIE_NAME,
  ORG_ID_HEADER,
  GB_BYTES,
  TB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  TRIAL_GRACE_DAYS,
  PAID_GRACE_DAYS,
  UNLIMITED,
  getUsageLimits,
  senderAddress,
} from './constants.js';
export type { AccessModel, UsageLimits } from './constants.js';
export { formatBytes, formatBytesShort } from './formatBytes.js';
export { UUID_PATTERN, isUuid } from './uuid.js';
export type {
  MeResponse,
  OrgMembershipSummary,
  MfaEnrollment,
  PasskeyEnrollment,
  UpdateProfileRequest,
  UpdateProfileResponse,
  RegenerateRecoveryCodeResponse,
  StepUpRequiredResponse,
} from './api/me.js';
export { PASSKEY_PER_USER_LIMIT, UpdateProfileSchema } from './api/me.js';

export type { PreferencesResponse, UpdatePreferencesRequest } from './api/preferences.js';
export { UpdatePreferencesSchema } from './api/preferences.js';

export { getProvider, isSocialConnection } from './connection-providers.js';
export type { ConnectionProvider } from './connection-providers.js';
export {
  OrgRole,
  isOrgRole,
  OrgNameSchema,
  UpdateOrgSchema,
  ORG_NAME_MIN_LENGTH,
  ORG_NAME_MAX_LENGTH,
  ORG_NAME_PATTERN,
  ORG_NAME_DISALLOWED_CHARS,
} from './api/org.js';
export type { OrgMembershipSource, UpdateOrgRequest, UpdateOrgResponse } from './api/org.js';

export {
  INVITATION_STATUSES,
  INVITE_EXPIRY_DAYS,
  INVITE_TOKEN_MAX_LENGTH,
  INVITE_TOKEN_MIN_LENGTH,
  MAX_PENDING_INVITATIONS_PER_ORG,
  AcceptInvitationSchema,
  CreateInvitationSchema,
  InvitedRoleSchema,
} from './api/invitations.js';
export type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  InvitationStatus,
  InvitationSummary,
  ListInvitationsResponse,
} from './api/invitations.js';

export { TransferOwnershipSchema, UpdateMemberRoleSchema } from './api/members.js';
export type {
  ListMembersResponse,
  MemberSummary,
  AccessKeySummary,
  RoleChangePreviewResponse,
  UpdateMemberRoleFailure,
  TransferOwnershipRequest,
  TransferOwnershipResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
} from './api/members.js';

export type {
  AuditQueryFilters,
  AuditQueryRequest,
  AuditWindow,
  ListAuditEventsResponse,
} from './api/audit.js';
export {
  AUDIT_EXPORT_MAX_BYTES,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_PAGE_SIZE,
  AuditQuerySchema,
  MALFORMED_CURSOR,
} from './api/audit.js';

export {
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_TYPE_LABELS,
  AUDIT_ACTOR_KINDS,
  AUDIT_EVENT_PHASES,
  AUDIT_OUTCOMES,
  AUDIT_REDACTED,
  AUDIT_RETENTION_DAYS,
  AUDIT_KEY_ID_SUFFIX_LENGTH,
  AUDIT_SECRET_BLOB_MIN_LENGTH,
  CREDENTIAL_VALUE_PATTERNS,
  PROHIBITED_AUDIT_CONTENT,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  TWO_PHASE_AUDIT_EVENT_TYPES,
  auditKeyIdSuffix,
  getAuditEventTypeLabel,
  isAuditEventType,
  looksLikeCredential,
} from './audit.js';
export type {
  AuditActor,
  AuditActorKind,
  AuditCompletionPhase,
  AuditDetailRecord,
  AuditDetailValue,
  AuditEvent,
  AuditEventDetails,
  AuditEventPhase,
  AuditEventRecord,
  AuditEventType,
  AuditIntentPhase,
  AuditKeyKind,
  AuditOutcome,
  RevocationTrigger,
  AuditPhaseFields,
  AuditSinglePhase,
  AuditSubject,
  CommittableAuditEvent,
  StandaloneAuditEvent,
  TwoPhaseAuditEvent,
  TwoPhaseAuditEventType,
  VendorBackedKeyEvent,
} from './audit.js';

export {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  permissionsForRole,
  roleHasPermission,
  canManageTargetRole,
  canChangeRole,
  roleNarrows,
  NO_ROLE,
} from './permissions.js';
export type { Permission } from './permissions.js';

export {
  ACCESS_KEY_PERMISSION_REQUIREMENT,
  GRANULAR_PERMISSION_REQUIREMENT,
  excessKeyPermissions,
  canRetainAccessKey,
} from './access-key-permissions.js';
export type {
  ExcessKeyPermission,
  AccessKeyRevocationReason,
  KeyRetentionResult,
  AccessKeyPermissions,
} from './access-key-permissions.js';

export { ROUTE_MANIFEST } from './route-manifest.js';
export type {
  RouteCategory,
  RouteHandler,
  RouteManifestEntry,
  RouteRequirement,
} from './route-manifest.js';
export { ApiErrorCode } from './api/coreInterfaces.js';
export type { ErrorResponse } from './api/coreInterfaces.js';
export {
  DELETION_CODE_LENGTH,
  DELETION_CODE_TTL_MINUTES,
  DeletionCodeSchema,
  DeleteAccountSchema,
} from './api/account-deletion.js';
export type {
  DeleteAccountRequest,
  RequestAccountDeletionResponse,
  ConfirmAccountDeletionResponse,
} from './api/account-deletion.js';

export type {
  Bucket,
  ListBucketsResponse,
  ListBucketsQuery,
  BucketSortKey,
  SortDirection,
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
  BUCKET_SORT_KEYS,
  SORT_DIRECTIONS,
  RETENTION_MODES,
  RETENTION_DURATION_TYPES,
  RETENTION_MAX_DAYS,
  RETENTION_MAX_YEARS,
  CreateBucketSchema,
  listBucketsUnavailableMessage,
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

export type {
  BulkDeleteFailure,
  BulkDeleteJob,
  CreateBulkDeleteJobRequest,
  CreateBulkDeleteJobResponse,
  GetBulkDeleteJobResponse,
} from './api/bulk-delete.js';

export {
  BulkDeleteJobStatus,
  BulkDeleteScope,
  CreateBulkDeleteJobSchema,
  MAX_REPORTED_BULK_DELETE_FAILURES,
  TERMINAL_BULK_DELETE_STATUSES,
  isTerminalBulkDeleteStatus,
} from './api/bulk-delete.js';

export {
  QueryBucketSchema,
  QUERY_DEFAULT_TOP_K,
  QUERY_MAX_TOP_K,
  SUPPORTED_COMPLETION_MODELS,
  SUPPORTED_COMPLETION_MODEL_IDS,
  SetBucketRagEnabledSchema,
} from './api/rag.js';

export type {
  QueryBucketRequest,
  QueryBucketResponse,
  CompletionModel,
  BucketRagStatus,
  BucketRagSyncState,
  SetBucketRagEnabledRequest,
  BucketRagEnablementResponse,
} from './api/rag.js';

export {
  ACCESS_KEY_PERMISSIONS,
  ACCESS_KEY_BUCKET_SCOPES,
  OBJECT_PERMISSIONS,
  BUCKET_PERMISSIONS,
  BUCKET_INFO_PERMISSIONS,
  isBucketPermission,
  isBucketInfoPermission,
  isObjectPermission,
  GRANULAR_PERMISSIONS,
  GRANULAR_PERMISSION_MAP,
  GRANULAR_PERMISSION_LABELS,
  BUCKET_PERMISSION_LABELS,
  BUCKET_INFO_PERMISSION_LABELS,
  KEY_NAME_MAX_LENGTH,
  KEY_NAME_PATTERN,
  RESERVED_KEY_NAME_PREFIX,
  isReservedKeyName,
  CreateAccessKeySchema,
} from './api/access-keys.js';
export type {
  AccessKeyStatus,
  AccessKeyPermission,
  AccessKeyBucketScope,
  ObjectPermission,
  BucketPermission,
  BucketInfoPermission,
  GranularPermission,
  AccessKey,
  ListAccessKeysResponse,
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  DeleteAccessKeyRequest,
} from './api/access-keys.js';

export {
  RAG_KEY_TOKEN_PREFIX,
  RAG_KEY_DISPLAY_PREFIX_LENGTH,
  RAG_KEY_MAX_BUCKETS,
  RAG_KEY_BUCKET_SCOPES,
  RagKeyBucketRefSchema,
  CreateRagApiKeySchema,
} from './api/rag-api-keys.js';
export type {
  RagKeyBucketScope,
  RagKeyBucketRef,
  RagApiKey,
  ListRagApiKeysResponse,
  CreateRagApiKeyRequest,
  CreateRagApiKeyResponse,
} from './api/rag-api-keys.js';

export { ACTIVITY_ACTION_LABELS, getActivityActionLabel } from './api/dashboard.js';

export type {
  UsageDataPoint,
  UsageTrendsRequest,
  UsageTrendsResponse,
  BucketActivity,
  ObjectActivity,
  KeyActivity,
  RecentActivity,
  RecentActivityResponse,
} from './api/dashboard.js';

export type { UsageResponse } from './api/usage.js';

export {
  PlanId,
  SubscriptionStatus,
  mapStripeStatus,
  ActivateSubscriptionRequestSchema,
} from './api/billing.js';
export type {
  Plan,
  Subscription,
  PaymentMethod,
  BillingInfo,
  CreateSetupIntentResponse,
  ActivateSubscriptionRequest,
  ActivateSubscriptionResponse,
  CreatePortalSessionResponse,
  Invoice,
  ListInvoicesResponse,
} from './api/billing.js';
export type { TenantStatus } from './api/tenants.js';
