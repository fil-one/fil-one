import { NoSuchBucket, NotFound } from '@aws-sdk/client-s3';

export function isNoSuchBucketError(err: unknown): boolean {
  return err instanceof NoSuchBucket;
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof NotFound;
}

/**
 * The credential itself was refused, as opposed to a policy answering no.
 *
 * A member's credential can be retired at the storage system without the
 * console hearing about it, so a caller signing as a member evicts on this and
 * re-reads once. `AccessDenied` is included because a gateway may spell a dead
 * key that way; it cannot cause extra minting, since eviction only drops the
 * cache entry and a mint happens only when SSM holds no parameter.
 */
export function isRejectedCredentialError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return (
    name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || name === 'AccessDenied'
  );
}
