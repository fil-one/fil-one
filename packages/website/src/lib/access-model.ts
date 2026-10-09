import { getRegionAccessModel, type S3Region } from '@filone/shared';

/**
 * Whether the orchestrator behind a region serves the `iam` access model:
 * buckets carry policies, and each member is a principal, an identity a policy
 * can grant access to, with keys of their own.
 *
 * The console's IAM surfaces all ask this one question, so a test can stand up
 * an `iam` region by mocking this module alone.
 */
export function isIamRegion(region: S3Region): boolean {
  return getRegionAccessModel(region) === 'iam';
}
