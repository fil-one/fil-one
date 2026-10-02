import { NoSuchBucket, NotFound, S3ServiceException } from '@aws-sdk/client-s3';

export function isNoSuchBucketError(err: unknown): boolean {
  return err instanceof NoSuchBucket;
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof NotFound;
}

export function isAccessDeniedError(err: unknown): boolean {
  return err instanceof S3ServiceException && err.name === 'AccessDenied';
}
