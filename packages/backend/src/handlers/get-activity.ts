import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AuditEvent, RecentActivity, RecentActivityResponse } from '@filone/shared';
import { isRagCompanionBucket } from '@filone/shared';
import { queryActivityEvents, resolveWindow } from '../lib/audit-query.ts';
import { reportAuditQuery } from '../lib/audit-metrics.ts';
import type { BucketSummary } from '../lib/bucket-orchestrator.ts';
import { getProvisionedRegions } from '../lib/region-helpers.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import {
  getRequestDeadline,
  requestDeadlineMiddleware,
  trackRequestStep,
} from '../middleware/request-deadline.ts';

/**
 * How long before a bucket's creation time its `bucket.created` event may be
 * stamped and still count as the record of it. The console writes the event
 * after the storage system answers, so the event is normally the later of the
 * two; the margin covers clock drift between the storage system and Lambda.
 */
const CREATION_MATCH_MARGIN_MS = 5 * 60 * 1000;

/**
 * When the console started writing `bucket.created`. A bucket made before it
 * has no creation in the log whichever way it was made, so it gets a plain
 * "Created" row, as the feed gave every bucket before it read the log. Must
 * not be earlier than the production deploy of that change: a console bucket
 * made between the two would read as created outside the console.
 */
export const BUCKET_CREATIONS_AUDITED_SINCE = '2026-11-10T00:00:00.000Z';

/**
 * GET /api/activity — the dashboard's activity feed, for Owner and Admin.
 *
 * Read from the audit log, so the dashboard's "View all" lands on the same
 * history, and gated on `audit.view` like the audit page it previews.
 *
 * The audit log records what the console did, so a bucket created with the
 * S3 API directly is missing from it. The feed lists the org's buckets beside
 * the read and adds a creation row for each bucket the log has no creation
 * for. A bucket deleted with the S3 API leaves nothing to list, so that
 * deletion never appears.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  const signal = getRequestDeadline(event);

  // The whole retention window up to now: the feed takes no dates.
  const { from, to } = resolveWindow({ to: new Date().toISOString() });
  const start = performance.now();
  // Named steps, so a read cut off by the deadline is logged by name.
  const [read, buckets] = await Promise.all([
    trackRequestStep(event, 'queryActivityEvents', () =>
      queryActivityEvents({ orgId, from, to, limit, signal }),
    ),
    trackRequestStep(event, 'listBuckets', () => listBuckets(orgId, signal)),
  ]);

  const recorded = read.events.flatMap(mapToActivities);
  reportAuditQuery({
    route: 'activity',
    cost: read.cost,
    durationMs: performance.now() - start,
    rowsReturned: recorded.length,
  });

  const unrecorded = getUnrecordedCreations({
    buckets,
    events: read.events,
    // Below the point the audit read stopped, the log's creations are not all
    // in hand, so a bucket there cannot be told apart and is left out.
    since: read.completeSince ?? from,
  });
  const activities = [...recorded, ...unrecorded]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);

  return new ResponseBuilder().status(200).body<RecentActivityResponse>({ activities }).build();
}

/**
 * Every bucket in the org's provisioned regions. A region that fails to list
 * is logged and skipped: its buckets then lack a creation row, and the audit
 * events still show.
 */
async function listBuckets(orgId: string, signal: AbortSignal): Promise<BucketSummary[]> {
  const regions = await getProvisionedRegions(orgId);
  const settled = await Promise.allSettled(
    // No member id: the feed is for Owner and Admin, who see every bucket.
    regions.map(({ orchestrator, tenantId }) =>
      orchestrator.listBuckets(tenantId, undefined, { signal }),
    ),
  );
  return settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      // Companion buckets hold Bucket Intelligence's datasets, not user data.
      return result.value.filter((bucket) => !isRagCompanionBucket(bucket.bucketName));
    }
    const { orchestrator, tenantId } = regions[index];
    console.error('[get-activity] Orchestrator listBuckets failed', {
      orgId,
      orchestratorId: orchestrator.id,
      region: orchestrator.region,
      tenantId,
      error: result.reason,
    });
    return [];
  });
}

/**
 * A creation row for each bucket made since `since` that the audit log has no
 * `bucket.created` for. Made after {@link BUCKET_CREATIONS_AUDITED_SINCE}, that
 * means it was created outside the console, and the row says so; made before,
 * the log could not have recorded it, and the row is a plain creation.
 *
 * A creation event counts for a bucket when it names the same bucket in the
 * same region and is no older than the bucket, give or take
 * {@link CREATION_MATCH_MARGIN_MS}. The age check keeps an old console creation
 * from covering a bucket of the same name deleted and made again over S3.
 */
function getUnrecordedCreations({
  buckets,
  events,
  since,
}: {
  buckets: BucketSummary[];
  events: AuditEvent[];
  since: string;
}): RecentActivity[] {
  const creations = events.flatMap((event) =>
    event.type === 'bucket.created' ? [{ ...event.details, at: Date.parse(event.createdAt) }] : [],
  );
  return buckets
    .filter((bucket) => Date.parse(bucket.createdAt) >= Date.parse(since))
    .filter(
      (bucket) =>
        !creations.some(
          (creation) =>
            creation.bucketName === bucket.bucketName &&
            creation.region === bucket.region &&
            creation.at >= Date.parse(bucket.createdAt) - CREATION_MATCH_MARGIN_MS,
        ),
    )
    .map((bucket) => ({
      // No event id exists; this one is stable for as long as the bucket is.
      id: `unrecorded:${bucket.region}:${bucket.bucketName}:${bucket.createdAt}`,
      timestamp: bucket.createdAt,
      resourceType: 'bucket',
      action: 'bucket.created',
      resourceName: bucket.bucketName,
      ...(Date.parse(bucket.createdAt) >= Date.parse(BUCKET_CREATIONS_AUDITED_SINCE) && {
        createdOutsideConsole: true,
      }),
    }));
}

/**
 * One audit event as a feed row. Empty for a type the feed does not render, so
 * a filter widened on the read side cannot reach the console unlabelled.
 */
function mapToActivities(event: AuditEvent): RecentActivity[] {
  const base = { id: event.eventId, timestamp: event.createdAt };
  switch (event.type) {
    case 'bucket.created':
    case 'bucket.deleted':
      return [
        {
          ...base,
          resourceType: 'bucket',
          action: event.type,
          resourceName: event.details.bucketName,
        },
      ];
    case 'key.created':
    case 'key.rotated':
    case 'key.deleted':
      return [
        {
          ...base,
          resourceType: 'key',
          action: event.type,
          // A revocation recorded before every one named its key carries only
          // the characters the console shows.
          resourceName:
            event.details.keyName ??
            (event.details.keyIdSuffix ? `…${event.details.keyIdSuffix}` : 'API key'),
        },
      ];
    default:
      return [];
  }
}

export const handler = middy(baseHandler)
  .use(requestDeadlineMiddleware())
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('audit.view'))
  .use(errorHandlerMiddleware());
