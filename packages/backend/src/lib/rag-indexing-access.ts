import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.ts';
import { orchestratorSupportsIamMethods } from './service-orchestrator-ids.ts';
import type { RegionOrchestrator, ServiceOrchestrator } from './service-orchestrator.ts';

/**
 * Refuse to index a bucket for a scoped member whose policies grant neither
 * listing nor reading it: the indexer lists and reads the bucket with the
 * tenant's key, and the query path answers from that content. Turning indexing
 * on and starting a sync on demand both ask this. A region serving service keys
 * has no policies to consult. The access model belongs to the network, so it
 * is asked of the orchestrator rather than of one region.
 */
export async function checkIndexingAccess(
  orchestrator: RegionOrchestrator,
  tenantId: string,
  bucketName: string,
  memberId: string | undefined,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (!memberId || !orchestratorSupportsIamMethods(orchestrator)) return undefined;
  const access = await (orchestrator as ServiceOrchestrator).resolveMemberAccess(
    tenantId,
    memberId,
  );
  const actions = access.find((entry) => entry.bucketName === bucketName)?.actions ?? [];
  if (actions.includes('s3:ListBucket') && actions.includes('s3:GetObject')) return undefined;
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({ message: `Your access to ${bucketName} does not permit indexing it.` })
    .build();
}
