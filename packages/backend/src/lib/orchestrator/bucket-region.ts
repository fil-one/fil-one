// Deciding which region serves a listed bucket. Split out so orchestrator.ts
// stays within its line budget.

import type { NonEmptyArray, S3Region } from '@filone/shared';

/**
 * The region serving a bucket the gateway listed.
 *
 * The gateway labels every bucket with the region serving it. A listing that
 * omits the label can only be answered on a single-region network, where there
 * is one region it could be; that case is a gateway that has not implemented
 * the label yet, so it warns rather than passing silently — once a second
 * region joins the network the same listing would be unanswerable. On a
 * multi-region network it already is, so it is refused rather than guessed, as
 * is a label naming a region the network does not serve.
 */
export function bucketRegion(
  network: { id: string; regions: NonEmptyArray<S3Region> },
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
  const message = `Bucket "${bucket.name}" was listed without a region by orchestrator "${network.id}".`;
  if (network.regions.length === 1) {
    console.warn(`[bucket-region] ${message} Reading it as "${network.regions[0]}".`);
    return network.regions[0];
  }
  throw new Error(message);
}
