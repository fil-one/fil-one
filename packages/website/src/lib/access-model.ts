import { getRegionAccessModel, type S3Region } from '@filone/shared';

/**
 * Whether the orchestrator behind a region serves the `iam` access model:
 * members are principals at the storage system, buckets carry policies, and a
 * key belongs to a member.
 *
 * The console's IAM surfaces all ask this one question, so a test can stand up
 * an `iam` region by mocking this module alone.
 */
export function isIamRegion(region: S3Region): boolean {
  return getRegionAccessModel(region) === 'iam';
}
