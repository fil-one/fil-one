// The shape a FilOne orchestrator is built with. Split out so orchestrator.ts
// stays within its line budget.

import type { NonEmptyArray, S3Region } from '@filone/shared';
import type { Client } from '@filone/orchestrator-client';

/** Where one region's S3 gateway is, when it is not where its name says. */
export interface S3Endpoint {
  endpointUrl: string;
  /** The same gateway as browsers reach it, when that differs from `endpointUrl`. */
  presignEndpointUrl?: string;
}

export interface FilOneOrchestratorConfig {
  /**
   * Orchestrator id (e.g. 'forge'). Must be stable: it drives the PROFILE
   * attribute the tenant id is stored under (`${id}TenantId`), the SSM path
   * segment for console S3 credentials (`/filone/<stage>/${id}-s3/...`), and
   * the metrics apiName dimension (`${id}-management`). Future wiring
   * (registry entry, sst.config IAM blocks) must honor the same derivations.
   */
  id: string;
  /** The regions the network serves; they share its tenant and console key. */
  regions: NonEmptyArray<S3Region>;
  /** Deployment stage — explicit (rather than read from process.env) so instances are testable. */
  stage: string;
  /**
   * Gateway overrides, by the region each one serves. A region without an entry
   * derives its endpoint from `getS3Endpoint`, which is every deployed network;
   * an override is for a gateway at an address no region name produces, such as
   * a local stack on a port.
   */
  s3Endpoints?: Partial<Record<S3Region, S3Endpoint>>;
  /**
   * Control-plane Management API access: either connection settings (the
   * factory builds and instruments a client) or a pre-built client (used by
   * tests and advanced callers; NOT auto-instrumented).
   */
  api: { client: Client } | { baseUrl: string; accessToken: string; fetch?: typeof fetch };
}
