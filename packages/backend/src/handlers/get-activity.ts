import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AuditEvent, RecentActivity, RecentActivityResponse } from '@filone/shared';
import { isRagCompanionBucket } from '@filone/shared';
import { queryActivityEvents, resolveWindow } from '../lib/audit-query.ts';
import { reportAuditQuery } from '../lib/audit-metrics.ts';
import type { BucketSummary } from '../lib/bucket-orchestrator.ts';
import { getProvisionedNetworks } from '../lib/region-helpers.ts';
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
 * stamped and still count as the record of it. The console writes the
 * completion after the storage system answers, so it is normally the later of
 * the two; the margin covers clock drift between the storage system and Lambda.
 * An intent is written just before the storage call, so the same margin covers
 * it too.
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
 * the audit log and adds a creation row for each bucket the log has no
 * creation for. A bucket deleted with the S3 API leaves nothing to list, so
 * that deletion never appears.
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
  // Named steps, so a read cut off by the deadline is logged by name.
  const [{ auditLog, auditQueryMs }, buckets] = await Promise.all([
    trackRequestStep(event, 'queryActivityEvents', async () => {
      // Timed on its own: the bucket listing runs beside it and is often slower.
      const start = performance.now();
      const auditLog = await queryActivityEvents({ orgId, from, to, limit, signal });
      return { auditLog, auditQueryMs: performance.now() - start };
    }),
    trackRequestStep(event, 'listBuckets', () => listBuckets(orgId, signal)),
  ]);

  const recorded = auditLog.events.flatMap(mapToActivities);
  reportAuditQuery({
    route: 'activity',
    cost: auditLog.cost,
    durationMs: auditQueryMs,
    rowsReturned: recorded.length,
  });

  const unrecorded = getUnrecordedBucketCreations({
    buckets,
    events: auditLog.bucketCreations,
    openCreations: auditLog.openBucketCreations,
    // Below the point the audit read stopped, the log's creations are not all
    // in hand, so a bucket there cannot be told apart and is left out.
    since: auditLog.completeSince ?? from,
  });
  const activities = [...recorded, ...unrecorded]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);

  return new ResponseBuilder().status(200).body<RecentActivityResponse>({ activities }).build();
}

/**
 * Every bucket on the org's provisioned networks. A network that fails to list
 * is logged and skipped, and so is the whole listing when the org's networks
 * cannot be read: those buckets then lack a creation row, and the audit events
 * still show.
 */
async function listBuckets(orgId: string, signal: AbortSignal): Promise<BucketSummary[]> {
  let networks: Awaited<ReturnType<typeof getProvisionedNetworks>>;
  try {
    networks = await getProvisionedNetworks(orgId);
  } catch (error) {
    console.error('[get-activity] getProvisionedNetworks failed', { orgId, error });
    return [];
  }
  const settled = await Promise.allSettled(
    // No member id: the feed is for Owner and Admin, who see every bucket.
    networks.map(({ orchestrator, tenantId }) =>
      orchestrator.listBuckets(tenantId, undefined, { signal }),
    ),
  );
  return settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      // Companion buckets hold Bucket Intelligence's datasets, not user data.
      return result.value.filter((bucket) => !isRagCompanionBucket(bucket.bucketName));
    }
    const { orchestrator, tenantId } = networks[index];
    console.error('[get-activity] Orchestrator listBuckets failed', {
      orgId,
      orchestratorId: orchestrator.id,
      tenantId,
      error: result.reason,
    });
    return [];
  });
}

/**
 * A creation row for each bucket made since `since` that the audit log has no
 * succeeded `bucket.created` for. Made after
 * {@link BUCKET_CREATIONS_AUDITED_SINCE}, that means it was created outside the
 * console, and the row says so; made before, the log could not have recorded
 * it, and the row is a plain creation.
 *
 * An open creation (an intent the console never completed, such as when the
 * storage call timed out) also makes the row a plain creation: someone started
 * that create in the console, and the audit page shows who.
 *
 * A creation event counts for a bucket when it names the same bucket in the
 * same region and is no older than the bucket, give or take
 * {@link CREATION_MATCH_MARGIN_MS}. The age check keeps an old console creation
 * from covering a bucket of the same name deleted and made again over S3.
 */
function getUnrecordedBucketCreations({
  buckets,
  events,
  openCreations,
  since,
}: {
  buckets: BucketSummary[];
  events: AuditEvent[];
  openCreations: AuditEvent[];
  since: string;
}): RecentActivity[] {
  const latestCreationAt = getLatestCreationTimes(events);
  const latestOpenCreationAt = getLatestCreationTimes(openCreations);
  return buckets
    .filter((bucket) => Date.parse(bucket.createdAt) >= Date.parse(since))
    .filter((bucket) => !isCreationCoveredBy(latestCreationAt, bucket))
    .map((bucket) => ({
      // No event id exists; this one is stable for as long as the bucket is.
      id: `unrecorded:${bucket.region}:${bucket.bucketName}:${bucket.createdAt}`,
      timestamp: bucket.createdAt,
      resourceType: 'bucket',
      action: 'bucket.created',
      resourceName: bucket.bucketName,
      ...(Date.parse(bucket.createdAt) >= Date.parse(BUCKET_CREATIONS_AUDITED_SINCE) &&
        !isCreationCoveredBy(latestOpenCreationAt, bucket) && { createdOutsideConsole: true }),
    }));
}

/**
 * The time of the latest `bucket.created` event per bucket. Only the latest
 * matters: if it is too old to cover the bucket, every earlier one is too.
 */
function getLatestCreationTimes(events: AuditEvent[]): Map<string, number> {
  const latestCreationAt = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'bucket.created') continue;
    const bucketKey = getBucketKey(event.details);
    const createdAt = Date.parse(event.createdAt);
    latestCreationAt.set(
      bucketKey,
      Math.max(createdAt, latestCreationAt.get(bucketKey) ?? createdAt),
    );
  }
  return latestCreationAt;
}

/** Whether one of the creations covers the bucket, by the rule {@link getUnrecordedBucketCreations} gives. */
function isCreationCoveredBy(
  latestCreationAt: Map<string, number>,
  bucket: BucketSummary,
): boolean {
  const creationAt = latestCreationAt.get(getBucketKey(bucket));
  return (
    creationAt !== undefined &&
    creationAt >= Date.parse(bucket.createdAt) - CREATION_MATCH_MARGIN_MS
  );
}

/** Identifies a bucket across regions, since names are unique only within one. */
function getBucketKey({ region, bucketName }: { region: string; bucketName: string }): string {
  return `${region}:${bucketName}`;
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
