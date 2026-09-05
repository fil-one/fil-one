import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, AUDIT_EXPORT_MAX_BYTES, AUDIT_EXPORT_MAX_ROWS } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { auditEvent, AuditSubjects, appendAuditEvent, userActor } from '../lib/audit.js';
import { reportAuditQuery } from '../lib/audit-metrics.js';
import { auditEventsToCsv } from '../lib/audit-csv.js';
import { queryAllAuditEvents } from '../lib/audit-query.js';
import { AuditFilterError, parseAuditRequest } from '../lib/audit-request.js';
import { csvResponse, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * GET /api/audit/export — the same filters as the viewer, as a CSV.
 *
 * Synchronous, with no job row, queue, worker, or bucket. The bulk-delete job
 * exists because deleting a large bucket takes longer than a request can stay
 * open; an export of control-plane events does not. An export object would also
 * be a second copy of the org's history with its own lifecycle, access story,
 * and teardown obligation.
 *
 * The filters travel rather than being ignored: the use that matters is an
 * investigator taking evidence for one member or one event type, and a 90-day
 * dump of everything is the wrong default for it.
 *
 * This is the one `GET` in the API that writes. `audit.exported` is the
 * highest-signal action the log records, because it is the one that takes the
 * org's history out of the system.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  const email = getVerifiedEmail(event);

  let filters;
  try {
    // The export reads the whole window, so a cursor on it means nothing; the
    // shared parser still holds it to the same rules rather than ignoring it.
    ({ filters } = parseAuditRequest(event.queryStringParameters ?? {}));
  } catch (err) {
    if (!(err instanceof AuditFilterError)) throw err;
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }

  const start = performance.now();
  const result = await queryAllAuditEvents({ orgId, filters, maxRows: AUDIT_EXPORT_MAX_ROWS });

  reportAuditQuery({
    route: 'export',
    cost: result.cost,
    durationMs: performance.now() - start,
    rowsReturned: result.events.length,
  });

  if (result.truncated) return tooLarge();

  const csv = auditEventsToCsv(result.events);
  // The byte budget behind the row cap, for a run of events whose `details` are
  // larger than the estimate the row cap was drawn from. Refused rather than
  // cut short: a truncated audit export is the worst failure this feature has,
  // and one that does not announce itself is worse than none.
  if (Buffer.byteLength(csv, 'utf8') > AUDIT_EXPORT_MAX_BYTES) return tooLarge();

  // Before the response, so a reader of the log sees the export even if the
  // transfer does not complete. It records that an export was produced, not
  // that the bytes arrived.
  await appendAuditEvent(
    auditEvent({
      type: 'audit.exported',
      actor: userActor({ userId, ...(email ? { email } : {}) }),
      orgId,
      subject: AuditSubjects.org(orgId),
      details: {
        from: result.window.from,
        to: result.window.to,
        ...(filters.eventType ? { eventType: filters.eventType } : {}),
        ...(filters.actorId ? { actorId: filters.actorId } : {}),
        rowCount: result.events.length,
      },
    }),
  );

  return csvResponse(csv, exportFilename(result.window.from, result.window.to));
}

/**
 * Refused with a remedy the console can act on: narrow the range, or filter to
 * one event type or one member.
 */
function tooLarge(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({
      message: `This export is over the ${AUDIT_EXPORT_MAX_ROWS.toLocaleString('en-US')} row limit. Narrow the date range, or filter by event type or member.`,
      code: ApiErrorCode.AUDIT_EXPORT_TOO_LARGE,
    })
    .build();
}

/** Names the window, so two exports in a downloads folder are tellable apart. */
function exportFilename(from: string, to: string): string {
  return `audit-log-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv`;
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('audit.export'))
  .use(errorHandlerMiddleware());
