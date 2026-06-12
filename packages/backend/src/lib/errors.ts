export class BucketAlreadyExistsError extends Error {
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" already exists`, options);
    this.name = 'BucketAlreadyExistsError';
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
