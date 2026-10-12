import { getRegionAccessModel, type S3Region } from '@filone/shared';

/** Whether the orchestrator behind a region serves bucket policies and members. */
export function supportsIamMethods(region: S3Region): boolean {
  return getRegionAccessModel(region) === 'iam';
}
