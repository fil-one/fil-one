import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AUDIT_PAGE_SIZE } from '@filone/shared';
import type { ErrorResponse, ListAuditEventsResponse } from '@filone/shared';
import { queryAuditEvents } from '../lib/audit-query.js';
import { reportAuditQuery } from '../lib/audit-metrics.js';
import { AuditFilterError, parseAuditRequest } from '../lib/audit-request.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * GET /api/audit — the org's recorded history, newest first.
 *
 * A date range, optionally one event type and one actor, and an opaque cursor.
 * The org comes from the caller's membership and never from the request, so
 * there is no parameter here that could name someone else's history.
 *
 * Owner and Admin only. The PRD's "an auditor joins as ReadOnly" flow would
 * need this route open to ReadOnly, and the review thread narrowed it instead:
 * an external auditor either holds an Admin seat or is sent a CSV by someone
 * who does.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  let request;
  try {
    request = parseAuditRequest(event.queryStringParameters ?? {});
  } catch (err) {
    if (!(err instanceof AuditFilterError)) throw err;
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }

  const start = performance.now();
  const page = await queryAuditEvents({
    orgId,
    filters: request.filters,
    limit: AUDIT_PAGE_SIZE,
    ...(request.cursor ? { cursor: request.cursor } : {}),
  });

  reportAuditQuery({
    route: 'list',
    cost: page.cost,
    durationMs: performance.now() - start,
    rowsReturned: page.events.length,
  });

  return new ResponseBuilder()
    .status(200)
    .body<ListAuditEventsResponse>({
      events: page.events,
      window: page.window,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('audit.view'))
  .use(errorHandlerMiddleware());
