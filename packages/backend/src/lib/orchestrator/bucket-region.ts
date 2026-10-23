// Deciding which region serves a listed bucket. Pure, and split out so
// orchestrator.ts stays within its line budget.

import type { S3Region } from '@filone/shared';

/**
 * The region serving a bucket the gateway listed. The gateway labels every
 * bucket with its own region; a listing that omits the label can only be
 * trusted on a single-region network, where there is one answer. On a
 * multi-region one it is a gateway bug that would misfile the bucket, so it is
 * refused rather than guessed, as is a label naming a region the network does
 * not serve.
 */
export function bucketRegion(
  network: { id: string; regions: S3Region[] },
  bucket: { name: string; region?: string },
): S3Region {
  if (bucket.region) {
    if (!network.regions.includes(bucket.region as S3Region)) {
      throw new Error(
        `Bucket "${bucket.name}" is served by region "${bucket.region}", which orchestrator "${network.id}" does not serve.`,
      );
    }
    return bucket.region as S3Region;
  }
  if (network.regions.length === 1) return network.regions[0]!;
  throw new Error(
    `Bucket "${bucket.name}" was listed without a region by multi-region orchestrator "${network.id}".`,
  );
}
