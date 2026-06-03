export class BucketAlreadyExistsError extends Error {
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" already exists`, options);
    this.name = 'BucketAlreadyExistsError';
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
