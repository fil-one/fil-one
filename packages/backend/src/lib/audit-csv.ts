import type { AuditEvent } from '@filone/shared';

/**
 * The audit export, as a CSV a spreadsheet opens without executing anything.
 *
 * Two escaping rules, and they are not the same rule. RFC 4180 quoting keeps a
 * comma, a quote, or a newline inside a value from becoming structure. The
 * formula guard keeps a value from becoming code when the file is opened. A
 * writer that does only the first produces a well-formed file that attacks its
 * reader.
 *
 * The existing client-side CSV writers in the console do neither, and are not a
 * template to copy.
 */

/**
 * A fixed envelope, plus one column holding `details` as JSON.
 *
 * `AuditEventDetails` carries a different shape per type, so a sheet with a
 * column per field of every type would be wide, mostly empty, and would grow a
 * column each time an event type is added. One JSON column stays honest about
 * the payload being per-type.
 */
export const AUDIT_CSV_COLUMNS = [
  'eventId',
  'createdAt',
  'type',
  'actorKind',
  'actorId',
  'actorEmail',
  'subject',
  'phase',
  'outcome',
  'correlationId',
  'details',
] as const;

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text.
 *
 * `orgName` and `keyName` are free text a customer typed, so an org named
 * `=HYPERLINK("http://attacker.example","Click")` reaches this writer as an
 * ordinary value and becomes a live formula in an auditor's Excel. Tab and
 * carriage return are here because a leading one is stripped by some readers,
 * exposing whatever follows it.
 *
 * The audit table's own prohibited-content guard watches for credentials
 * leaving the system and has nothing to say about a payload that executes when
 * the file is opened.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * One cell, safe to open and safe to parse.
 *
 * A leading apostrophe is what tells Excel, LibreOffice, and Sheets to treat
 * what follows as text. It has to go inside the RFC 4180 quoting rather than
 * beside it, or the file no longer parses as CSV.
 *
 * Applied to every field, not to the ones that look risky. `details` is JSON
 * built from customer values, `subject` is assembled from ids, and a rule that
 * has to be remembered per column is a rule that will be missed.
 */
export function escapeCsvCell(value: string): string {
  const guarded = FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger))
    ? `'${value}`
    : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function csvRow(cells: string[]): string {
  return cells.map(escapeCsvCell).join(',');
}

/**
 * One event as its row.
 *
 * `createdAt` goes out exactly as stored, in UTC. The viewer renders local time
 * with the offset shown; a file that is going to a security review should carry
 * the instant the log holds, not the timezone of whoever pressed the button.
 */
function auditCsvRow(event: AuditEvent): string {
  return csvRow([
    event.eventId,
    event.createdAt,
    event.type,
    event.actor.kind,
    event.actor.id,
    event.actor.email ?? '',
    event.subject,
    event.phase ?? '',
    event.outcome ?? '',
    event.correlationId ?? '',
    JSON.stringify(event.details),
  ]);
}

/**
 * The whole file, header included.
 *
 * CRLF line endings, which is what RFC 4180 specifies and what keeps the file
 * opening cleanly on Windows, where most auditors are.
 */
export function auditEventsToCsv(events: AuditEvent[]): string {
  return [csvRow([...AUDIT_CSV_COLUMNS]), ...events.map(auditCsvRow)].join('\r\n') + '\r\n';
}
