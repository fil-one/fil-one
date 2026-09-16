export class BucketAlreadyExistsError extends Error {
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" already exists`, options);
    this.name = 'BucketAlreadyExistsError';
  }
}

// Thrown when a bucket cannot be deleted because it still holds objects or object
// versions. Every transport translates its own flavour of this failure (S3
// `BucketNotEmpty`, Aurora Portal 409) into this one error so handlers can return a
// single machine-readable 409 the frontend acts on.
export class BucketNotEmptyError extends Error {
  readonly bucketName: string;
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" is not empty`, options);
    this.name = 'BucketNotEmptyError';
    this.bucketName = bucketName;
  }
}

// Thrown when a bucket is created successfully but a follow-up configuration
// step (versioning / object-lock / default retention) fails. These steps are
// non-atomic with the create, so on this error the bucket already exists and a
// naive retry will hit BucketAlreadyExistsError (409). The message is user-facing
// guidance (surfaced to the API caller): it tells them the bucket exists and how to
// finish configuring it via the S3 API, so a partial failure isn't a dead end.
export class BucketConfigurationError extends Error {
  readonly bucketName: string;
  constructor(bucketName: string, options?: ErrorOptions) {
    super(
      `Bucket "${bucketName}" was created, but applying its versioning/object-lock settings failed. ` +
        `The bucket already exists; apply the remaining settings manually with the S3 API ` +
        `(PutBucketVersioning for versioning, PutObjectLockConfiguration for object lock and default retention).`,
      options,
    );
    this.name = 'BucketConfigurationError';
    this.bucketName = bucketName;
  }
}

// Thrown by data-plane reads (e.g. getBucketUsageMetrics) when the bucket is not
// found or is not owned by the tenant. The ownership check is tenant-scoped, so a
// bucket belonging to another tenant surfaces as not-found rather than leaking its
// existence. Handlers catch this to return a 404.
export class BucketNotFoundError extends Error {
  readonly bucketName: string;
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" not found`, options);
    this.name = 'BucketNotFoundError';
    this.bucketName = bucketName;
  }
}

export class AccessKeyAlreadyExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super('An access key with this name already exists', options);
    this.name = 'AccessKeyAlreadyExistsError';
  }
}

export class AccessKeyValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccessKeyValidationError';
  }
}

export class NotImplementedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotImplementedError';
  }
}

// Thrown when ensuring a trial entitlement fails for a transient/infrastructure
// reason (DynamoDB or Stripe unavailable) rather than because the user is not
// entitled. Callers should let this propagate so the error-handler returns a 5xx
// (retryable) instead of masking it as a 403 "subscription inactive".
export class TrialEntitlementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrialEntitlementError';
  }
}

// ── Bucket policies and principals (`iam` access model) ──────────────────

// The bucket exists and has no policy. Its own class rather than a null from
// every caller because the write path needs it too: a DELETE of a policy that
// is not there is this, and a bucket that is not there is BucketNotFoundError.
export class PolicyNotFoundError extends Error {
  readonly bucketName: string;
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" has no policy`, options);
    this.name = 'PolicyNotFoundError';
    this.bucketName = bucketName;
  }
}

// The ETag the write carried no longer matches the stored policy, or the write
// asked to create a first policy where one exists. Nothing was written. Never
// retried here: the caller has to read the current document and decide again.
export class PolicyPreconditionFailedError extends Error {
  readonly bucketName: string;
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`The policy of bucket "${bucketName}" changed since it was read`, options);
    this.name = 'PolicyPreconditionFailedError';
    this.bucketName = bucketName;
  }
}

// The storage system could not take its lock within its timeout because another
// change to the same principal or policy was in flight. Nothing was written, and
// the same request may be retried.
export class PolicyConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super('Another change to this policy was in flight', options);
    this.name = 'PolicyConflictError';
  }
}

// The storage system refused the document or the principal id. The message is
// the upstream one and is safe to show: it names the statement or field at
// fault and nothing about the tenant.
export class PolicyValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PolicyValidationError';
  }
}

// A policy write failed after the storage system had published revocations for
// it, so it committed nothing and the old policy stays in force. Retrying the
// same write is the documented recovery: each publish carries a fresh nonce.
export class PolicyPublishError extends Error {
  constructor(options?: ErrorOptions) {
    super('The storage system could not publish the policy change', options);
    this.name = 'PolicyPublishError';
  }
}

// A key or statement named a principal the tenant does not have: the member was
// never synced, or was removed.
export class PrincipalNotFoundError extends Error {
  readonly principalId: string;
  constructor(principalId: string, options?: ErrorOptions) {
    super(`Principal "${principalId}" does not exist at the storage system`, options);
    this.name = 'PrincipalNotFoundError';
    this.principalId = principalId;
  }
}
