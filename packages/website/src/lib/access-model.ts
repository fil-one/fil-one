import { getRegionAccessModel } from '@filone/shared';
import type { S3Region } from '@filone/shared';

/**
 * Whether a region serves the `iam` access model: members are principals at
 * the storage system, buckets carry policies, and a key belongs to a member.
 *
 * A one-line wrapper over the shared switch so the console's IAM surfaces all
 * ask the same question and a test can stand up an `iam` region by mocking
 * this module alone. No region answers `iam` today.
 */
export function isIamRegion(region: S3Region): boolean {
  return getRegionAccessModel(region) === 'iam';
}
