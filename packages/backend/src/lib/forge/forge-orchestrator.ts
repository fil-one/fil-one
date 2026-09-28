// Forge service orchestrators. Forge ("Hilt" on the Forge side) is backed by
// the generic Service Orchestrator Management API (createFilOneOrchestrator).
// Forge runs as independent networks, each with its own Hilt serving every
// region in that network; the region is sent per-tenant in the PUT /tenants
// body. Non-production talks to two of them, staging and the dev sandbox;
// production will have a single one. The Management API endpoint and bearer
// token therefore belong to the network, which is why both are passed in rather
// than read here.
//
// Each region gets a unique ID so its console-key SSM path (`${id}-s3`), PROFILE
// attribute (`${id}TenantId`), and metrics namespace (`${id}-management`) stay
// isolated. Adding a new Forge region is: a unique ID, a new S3Region value and
// a registry entry; everything id-derived follows automatically.
//
// Constructed lazily by the registry (never at import): the Forge token secrets
// are linked only on non-production stages, so eager construction would crash
// production at import time.

import type { S3Region } from '@filone/shared';
import { createFilOneOrchestrator } from '../orchestrator/orchestrator.ts';
import type { ServiceOrchestrator } from '../service-orchestrator.ts';

/** Management API endpoint and bearer credential of one Forge network's Hilt. */
export interface ForgeManagementApi {
  baseUrl: string;
  accessToken: string;
}

/**
 * @param id The unique identifier for the Forge orchestrator. It should have
 *           the format `^[a-z][a-zA-Z0-9_]*$`.
 * @param regions The S3 regions the network serves. A tenant on the network is
 *                region-free, so every region shares its tenant and console key.
 * @param api The Hilt endpoint and bearer token of the Forge network.
 * @returns A `ServiceOrchestrator` instance for the Forge network.
 */
export function createForgeOrchestrator(
  id: string,
  regions: S3Region[],
  api: ForgeManagementApi,
): ServiceOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  return createFilOneOrchestrator({ id, regions, stage, api });
}
