import { isSupportedRegion } from '@filone/shared';
import { checkMemberBucketAccess } from '../../handlers/presign.ts';
import { requirePermission } from '../../middleware/authorize.ts';
import { toConsoleRouteResult, type ConsoleRouteResult } from './mcp-console-route.ts';
import { getScopedMemberId } from '../member-scope.ts';
import { getOrgProfile } from '../org-profile.ts';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../response-builder.ts';
import { listObjects } from '../s3-bucket-operations.ts';
import { createS3Client } from '../s3-client.ts';
import { isNoSuchBucketError } from '../s3-errors.ts';
import { getOrchestratorForRegion } from '../service-orchestrator-registry.ts';
import type { AuthenticatedEvent } from '../user-context.ts';
import { getUserInfo } from '../user-context.ts';

/**
 * One page of a bucket's objects, read by the backend: keys, sizes and dates,
 * never contents. The console lists through a presigned URL instead, so this
 * runs the presign route's checks for a listObjects operation itself: the
 * caller's role, then their bucket policies.
 */
export async function listBucketObjects(
  event: AuthenticatedEvent,
  args: Record<string, unknown>,
): Promise<ConsoleRouteResult> {
  const bucket = String(args.bucketName);
  const region = String(args.region);
  const denied = requirePermission(
    event,
    'objects.read',
    'Your role in this organization does not permit listObjects.',
  );
  if (denied) return toConsoleRouteResult(denied);
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return toConsoleRouteResult(unsupportedRegionResponse(region));
  }

  const { orgId, userId, membership } = getUserInfo(event);
  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return toConsoleRouteResult(tenantNotReadyResponse());

  const refused = await checkMemberBucketAccess(
    orchestrator,
    tenantId,
    getScopedMemberId(membership?.role, userId),
    [{ op: 'listObjects', bucket }],
  );
  if (refused) return toConsoleRouteResult(refused);

  const s3 = createS3Client(await orchestrator.getS3ClientContext(tenantId, region));
  try {
    const page = await listObjects({
      s3,
      bucket,
      prefix: typeof args.prefix === 'string' ? args.prefix : undefined,
      maxKeys: typeof args.maxKeys === 'number' ? args.maxKeys : undefined,
      continuationToken:
        typeof args.continuationToken === 'string' ? args.continuationToken : undefined,
      signal: event.requestContext.deadline,
    });
    return { statusCode: 200, body: page };
  } catch (err) {
    if (!isNoSuchBucketError(err)) throw err;
    return toConsoleRouteResult(
      new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build(),
    );
  }
}
