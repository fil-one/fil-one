// Forge service orchestrators. Forge ("Hilt" on the Forge side) is backed by
// the generic Service Orchestrator Management API (createFilOneOrchestrator).
// A single shared Management API endpoint and bearer token serve every Forge
// region; the region is sent per-tenant in the PUT /tenants body.
//
// Even though each Forge region is orchestrated by the same Hilt instance, the
// ID is unique so each region's console-key SSM path (`${id}-s3`), PROFILE
// attribute (`${id}TenantId`), and metrics namespace (`${id}-management`) stay
// isolated. Adding a new Forge region is: a unique ID, a new S3Region value and
// a registry entry; everything id-derived follows automatically.
//
// Constructed lazily by the registry (never at import): the ForgeManagementApiToken
// secret is linked only on non-production stages, so eager construction would
// crash production at import time.

import { getS3Endpoint, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { createFilOneOrchestrator } from '../orchestrator/orchestrator.js';
import type { ServiceOrchestrator } from '../service-orchestrator.js';

/**
 * @param id The unique identifier for the Forge orchestrator. It should have
 *           the format `^[a-z][a-zA-Z0-9_]*$`.
 * @param region The S3 region the orchestrator will manage.
 * @returns A `ServiceOrchestrator` instance configured for the specified Forge
 *          region.
 */
export function createForgeOrchestrator(id: string, region: S3Region): ServiceOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  return createFilOneOrchestrator({
    id,
    region,
    stage,
    s3EndpointUrl: getS3Endpoint(region, stage),
    api: {
      baseUrl: process.env.FORGE_MANAGEMENT_API_URL!,
      // Shared bearer credential, resolved lazily by the factory's auth callback.
      accessToken: Resource.ForgeManagementApiToken.value,
    },
  });
}
