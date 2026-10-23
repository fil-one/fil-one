// The shape a FilOne orchestrator is built with. Split out so orchestrator.ts
// stays within its line budget.

import type { NonEmptyArray, S3Region } from '@filone/shared';
import type { Client } from '@filone/orchestrator-client';

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
   * S3 gateway endpoint for the data plane, overriding the one derived from the
   * region with `getS3Endpoint`. A network serving several regions has an
   * endpoint per region, so only a single-region network can set this.
   */
  s3EndpointUrl?: string;
  /** The same gateway as browsers reach it, when that differs from the endpoint. */
  s3PresignEndpointUrl?: string;
  /**
   * Control-plane Management API access: either connection settings (the
   * factory builds and instruments a client) or a pre-built client (used by
   * tests and advanced callers; NOT auto-instrumented).
   */
  api: { client: Client } | { baseUrl: string; accessToken: string; fetch?: typeof fetch };
}
