import { NoSuchBucket } from '@aws-sdk/client-s3';

export function isNoSuchBucketError(err: unknown): boolean {
  return err instanceof NoSuchBucket;
}
