import { getAvailableRegions, isSupportedRegion, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.ts';
import type { S3Endpoint } from './orchestrator/config.ts';
import { createForgeOrchestrator, type ForgeManagementApi } from './forge/forge-orchestrator.ts';
import { createFthOrchestrator, createInstrumentedFthClient } from './fth/fth-orchestrator.ts';
import { NetworkNotRunningError } from './errors.ts';
import {
  ORCHESTRATOR_ID_BY_REGION,
  getRegionsForOrchestrator,
} from './service-orchestrator-ids.ts';
import type {
  LegacyServiceOrchestrator,
  NetworkOrchestrator,
  ServiceOrchestrator,
} from './service-orchestrator.ts';

// Aurora is built at import; its module reads no secret while loading. FTH and
// Forge are built lazily on the first request for their region and memoized,
// because construction reads a linked secret. For Forge the secrets are linked
// only on non-production stages, so eager construction would crash production
// at import. For FTH the secret is linked everywhere, and deferring the read
// keeps this module and everything it imports loadable under plain node, where
// bin/ scripts run without `sst shell`. The Forge api config arrives as a thunk
// for the same reason: an argument evaluated at every registry call would touch
// the secret on stages that never link it.
let fthOrchestrator: LegacyServiceOrchestrator | undefined;
const forgeOrchestrators = new Map<string, ServiceOrchestrator>();

// One Forge network per Hilt, keyed by the orchestrator id its regions map to
// in ORCHESTRATOR_ID_BY_REGION. A network is built once and serves every region
// of its id: its tenant is region-free, so the regions share tenant state and
// the console key.
const FORGE_NETWORKS: Record<
  string,
  { api: () => ForgeManagementApi; s3Endpoints?: Partial<Record<S3Region, S3Endpoint>> }
> = {
  forge: {
    api: () => managementApi('forge', 'FORGE_MANAGEMENT_API_URL', Resource.ForgeManagementApiToken),
  },
  forgeDev: {
    api: () =>
      managementApi(
        'forgeDev',
        'FORGE_DEV_MANAGEMENT_API_URL',
        Resource.ForgeDevManagementApiToken,
      ),
    // The dev stack's gateways are local ports, which no region name
    // produces, so the overrides are keyed by the region each serves.
    get s3Endpoints() {
      return localEndpoints({
        [S3Region.UsEast9]: 'FORGE_DEV_S3_ENDPOINT_URL',
        [S3Region.EuCentral9]: 'FORGE_DEV_EU_S3_ENDPOINT_URL',
      });
    },
  },
  // A second smelt network on the same machine, so a local stage can show an
  // account reaching two networks. No hosted counterpart: only a local stage
  // offers its region.
  forgeDev2: {
    api: () =>
      managementApi(
        'forgeDev2',
        'FORGE_DEV2_MANAGEMENT_API_URL',
        Resource.ForgeDev2ManagementApiToken,
      ),
    get s3Endpoints() {
      return localEndpoints({ [S3Region.UsWest9]: 'FORGE_DEV2_S3_ENDPOINT_URL' });
    },
  },
};

/**
 * The S3 endpoint overrides a local stage sets, one region at a time. A
 * region whose variable is unset is left out, so it falls back to the name
 * the region produces; with none set the network has no overrides at all.
 *
 * The browser fetches a presigned URL itself, and an https page may fetch
 * http://localhost but no other plain-http host, so each endpoint has a
 * matching `<NAME>_PRESIGN_` variable carrying the localhost form.
 */
function localEndpoints(
  byRegion: Partial<Record<S3Region, string>>,
): Partial<Record<S3Region, S3Endpoint>> | undefined {
  const endpoints: Partial<Record<S3Region, S3Endpoint>> = {};
  for (const [region, variable] of Object.entries(byRegion) as [S3Region, string][]) {
    const endpointUrl = process.env[variable];
    if (!endpointUrl) continue;
    const presignEndpointUrl = process.env[variable.replace('_S3_', '_S3_PRESIGN_')];
    endpoints[region] = { endpointUrl, ...(presignEndpointUrl && { presignEndpointUrl }) };
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

/**
 * A network's Management API, or a refusal naming it. A deployment sets the
 * endpoint of every network it runs, so one left unset is a network this
 * deployment does not run: a local stage against a smelt stack of one network
 * offers the regions of the second but has nowhere to send them. Failing here
 * says so, rather than reaching for an address that is not there.
 */
function managementApi(id: string, variable: string, token: { value: string }): ForgeManagementApi {
  const baseUrl = process.env[variable];
  if (!baseUrl) throw new NetworkNotRunningError(id);
  return { baseUrl, accessToken: token.value };
}

function getForgeOrchestrator(id: string, stage: string): ServiceOrchestrator {
  let orchestrator = forgeOrchestrators.get(id);
  if (!orchestrator) {
    const network = FORGE_NETWORKS[id];
    if (!network) throw new Error(`No Forge network is configured for orchestrator "${id}".`);
    // Destructured rather than length-checked: it gives the non-empty list the
    // orchestrator takes, and a stage this id serves no region on is caught here
    // rather than inside the orchestrator.
    const [first, ...rest] = getRegionsForOrchestrator(id, stage);
    if (!first) throw new Error(`Orchestrator "${id}" serves no region on stage "${stage}".`);
    orchestrator = createForgeOrchestrator(
      id,
      [first, ...rest],
      network.api(),
      network.s3Endpoints,
    );
    forgeOrchestrators.set(id, orchestrator);
  }
  return orchestrator;
}

/** The orchestrator (storage network) serving a region. */
export function getOrchestratorForRegion(region: S3Region): NetworkOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  if (!isSupportedRegion(region, stage)) {
    throw new Error(`Unsupported region "${String(region)}".`);
  }

  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    case S3Region.UsEast1:
      fthOrchestrator ??= createFthOrchestrator(createInstrumentedFthClient());
      return fthOrchestrator;
  }

  // Every other supported region is served by a Forge network, which the ids
  // map names.
  return getForgeOrchestrator(ORCHESTRATOR_ID_BY_REGION[region], stage);
}

/**
 * Every orchestrator available on this stage, once each and in first-region
 * order. A network serving several regions appears once: its tenant, console
 * key and bucket listing are shared across them, so a per-network loop must
 * not visit it twice.
 */
export function getAvailableOrchestrators(): NetworkOrchestrator[] {
  const stage = process.env.FILONE_STAGE!;
  const seen = new Set<NetworkOrchestrator>();
  for (const region of getAvailableRegions(stage)) {
    try {
      seen.add(getOrchestratorForRegion(region));
    } catch (error) {
      // A deployment may run fewer networks than its stage offers, and the
      // ones it does run still answer. Leaving the missing one out keeps a
      // listing to what is there; a request naming its region still fails.
      if (!(error instanceof NetworkNotRunningError)) throw error;
    }
  }
  return [...seen];
}

/**
 * The orchestrator with this id, or undefined when no network by that id is
 * available on this stage. This is how a stored key row, which records the
 * network that holds its credential, finds its way back to it.
 */
export function findOrchestratorById(id: string): NetworkOrchestrator | undefined {
  return getAvailableOrchestrators().find((orchestrator) => orchestrator.id === id);
}
