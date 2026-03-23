import { NoSuchBucket, NotFound } from '@aws-sdk/client-s3';

export function isNoSuchBucketError(err: unknown): boolean {
  return err instanceof NoSuchBucket;
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof NotFound;
}
