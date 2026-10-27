import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AuditEvent, RecentActivity, RecentActivityResponse } from '@filone/shared';
import { queryActivityEvents } from '../lib/audit-query.ts';
import type { ActivityBucketScope, ActivityScope } from '../lib/audit-query.ts';
import { reportAuditQuery } from '../lib/audit-metrics.ts';
import { keyScope } from '../lib/key-scope.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { requestDeadlineMiddleware, trackRequestStep } from '../middleware/request-deadline.ts';

/**
 * GET /api/activity — the dashboard's activity feed.
 *
 * Read from the audit log, so every row here is a row the audit page shows too
 * and the dashboard's "View all" lands on the same history. The audit page is
 * Owner and Admin only; this feed is open to every role under `buckets.read`
 * because it carries only bucket and key events, and below Admin only the ones
 * the caller acted on.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );

  const start = performance.now();
  // A named step, so a read still draining when the deadline fires is logged.
  const { events, cost } = await trackRequestStep(event, 'queryActivityEvents', () =>
    queryActivityEvents({
      orgId,
      bucketEvents: getBucketEventScope(event),
      keyEvents: getKeyEventScope(event),
      limit,
    }),
  );

  const activities = events.flatMap(mapToActivities);
  reportAuditQuery({
    route: 'activity',
    cost,
    durationMs: performance.now() - start,
    rowsReturned: activities.length,
  });

  return new ResponseBuilder().status(200).body<RecentActivityResponse>({ activities }).build();
}

/**
 * The bucket events this caller may see: the whole org's for Owner and Admin,
 * and only those the caller acted on for everyone else. A bucket on a region
 * with per-member access is open to a Member only through a policy naming them,
 * and the Buckets page lists only those, so the feed must not name the rest.
 * Reading what the caller did is the narrowing that needs no storage-system call;
 * it also hides a bucket someone else created and then shared with them.
 */
function getBucketEventScope(event: AuthenticatedEvent): ActivityBucketScope {
  const { userId, membership } = getUserInfo(event);
  const memberId = getScopedMemberId(membership?.role, userId);
  return memberId ? { sees: 'own', actorId: memberId } : { sees: 'all' };
}

/**
 * The key events this caller may see, under the scope the keys pages use: the
 * whole org's under `keys.manage_all`, those the caller acted on under
 * `keys.manage_own`, and none for a ReadOnly member who holds neither.
 */
function getKeyEventScope(event: AuthenticatedEvent): ActivityScope {
  const scope = keyScope(event);
  return scope.sees === 'own' ? { sees: 'own', actorId: scope.userId } : scope;
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
  .use(authorize('buckets.read'))
  .use(errorHandlerMiddleware());
