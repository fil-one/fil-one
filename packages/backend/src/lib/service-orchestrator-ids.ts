// Which orchestrator serves each region, as a name. The registry answers the
// same question with a built orchestrator, and building one reads a linked
// secret, so a bin/ script running outside `sst shell` cannot ask it. This
// module reads nothing at import and loads under plain node.

import { S3Region } from '@filone/shared';

/**
 * The orchestrator behind each region, by the id it stores on the account
 * profile as `{orchestratorId}TenantId` and in the SSM path
 * `/filone/{stage}/{orchestratorId}-s3/...`. The type makes a new member of
 * {@link S3Region} fail to compile until it has an entry here; the registry
 * test holds every built orchestrator's id to this map.
 */
export const ORCHESTRATOR_ID_BY_REGION: Record<S3Region, string> = {
  [S3Region.EuWest1]: 'aurora',
  [S3Region.UsEast1]: 'fth',
  [S3Region.EuCentral3]: 'forge',
  [S3Region.UsEast9]: 'forgeDev',
};

/** The orchestrator id behind a region, or undefined for a region the product does not know. */
export function orchestratorIdForRegion(region: string): string | undefined {
  return Object.values(S3Region).includes(region as S3Region)
    ? ORCHESTRATOR_ID_BY_REGION[region as S3Region]
    : undefined;
}
