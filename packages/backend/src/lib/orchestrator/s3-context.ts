// Building the S3 client context a data-plane call signs with. Split out so
// orchestrator.ts stays within its line budget.

import { getS3Endpoint, type S3Region } from '@filone/shared';
import { assertServesRegion } from '../service-orchestrator-ids.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';
import type { S3ClientContext } from '../s3-client.ts';
import { getConsoleS3Credentials } from '../s3-credentials.ts';

export interface S3ContextConfig {
  orchestratorId: string;
  stage: string;
  /** The regions the network serves; a call naming another one is refused. */
  regions: S3Region[];
  /** Overrides the endpoint derived from the region. Single-region networks only. */
  s3EndpointUrl?: string;
  /** The same gateway as browsers reach it, when that differs from the endpoint. */
  s3PresignEndpointUrl?: string;
}

/**
 * Credentials and endpoint for the S3 gateway of `region`. The credential is
 * the tenant's console key, the same at every region of the network; only the
 * endpoint and the signing region change.
 */
export async function buildS3ClientContext(
  config: S3ContextConfig,
  tenantId: string,
  region: S3Region,
  requestOptions?: OrchestratorRequestOptions,
): Promise<S3ClientContext> {
  // A region this network does not serve has no gateway to send the request to.
  assertServesRegion({ id: config.orchestratorId, regions: config.regions }, region);
  const credentials = await getConsoleS3Credentials(
    { orchestratorId: config.orchestratorId, stage: config.stage, tenantId },
    requestOptions,
  );
  return {
    endpointUrl: config.s3EndpointUrl ?? getS3Endpoint(region, config.stage),
    region,
    credentials,
    forcePathStyle: true,
    orchestratorId: config.orchestratorId,
    tenantId,
    ...(config.s3PresignEndpointUrl && { presignEndpointUrl: config.s3PresignEndpointUrl }),
  };
}
