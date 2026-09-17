import { CaretDownIcon, CaretRightIcon, ScrollIcon } from '@phosphor-icons/react/dist/ssr';
import { getAuditEventTypeLabel } from '@filone/shared';
import type { AuditEvent } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { EmptyStateCard } from './EmptyStateCard';
import { StateCard } from './StateCard';
import { Table } from './Table';
import { TableSkeleton } from './Table/TableSkeleton.js';
import { errorMessageOf } from '../lib/api.js';
import { formatDateTime } from '../lib/time.js';
import { useInView } from '../lib/use-in-view.js';

/**
 * The columns, shared with the loading skeleton so the placeholder drops the
 * same column at the same breakpoint as the table it stands in for.
 */
export const COLUMNS = [
  { label: 'Event' },
  { label: 'Member' },
  { label: 'Subject', className: 'hidden md:table-cell' },
  { label: 'When' },
];

export interface AuditLogTableProps {
  /** Undefined while the first page is in flight. */
  events?: AuditEvent[];
  isPending: boolean;
  /** Set when the read failed; the message is shown as-is. */
  error?: unknown;
  /** Whether a filter is on, which decides what an empty result means. */
  filtered: boolean;
  /** The one row whose payload is open, if any. */
  expanded: string | null;
  onToggleExpand: (eventId: string) => void;
  onFilterActor: (actorId: string) => void;
  /** Another page of older events exists behind this one. */
  hasNextPage?: boolean;
  isLoadingMore?: boolean;
  /** Asked for as the reader reaches the end of the rows. */
  onLoadMore?: () => void;
}

/**
 * The org's history as a table, with every state it can be in.
 *
 * Presentational: it takes rows and says nothing about where they came from, so
 * each state has a story and the tab above it owns the fetching and the filters.
 */
export function AuditLogTable({
  events,
  isPending,
  error,
  filtered,
  expanded,
  onToggleExpand,
  onFilterActor,
  hasNextPage = false,
  isLoadingMore = false,
  onLoadMore,
}: AuditLogTableProps) {
  // Continues on scroll rather than on a click: an auditor looking for one old
  // event should not have to ask for each page of the way there. Held off while
  // a page is in flight, and after a failure — retrying on scroll would put a
  // failing request behind every wheel event, so that case asks instead.
  const sentinel = useInView<HTMLDivElement>(() => onLoadMore?.(), {
    enabled: hasNextPage && !isLoadingMore && error === undefined && onLoadMore !== undefined,
  });

  if (isPending) {
    return <TableSkeleton columns={COLUMNS} aria-label="Loading the audit log" />;
  }

  if (error !== undefined && !events) {
    return (
      <StateCard border="solid">
        <p className="mb-1 text-sm font-medium text-zinc-900">The audit log could not be loaded.</p>
        <p className="text-sm text-zinc-500">{errorMessageOf(error, 'Try again in a moment.')}</p>
      </StateCard>
    );
  }

  if (!events || events.length === 0) {
    return (
      <EmptyStateCard
        icon={ScrollIcon}
        iconColor="grey"
        title={filtered ? 'No events match these filters' : 'No events yet'}
        description={
          filtered
            ? 'Widen the date range, or clear the event and member filters.'
            : 'Changes to members, invitations, keys and this organization are recorded here as they happen.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* A failed refetch keeps the last answer on screen, so it has to say so.
          Reading stale history as current is the mistake this surface can least
          afford. Same shape as the members roster's stale notice. */}
      {error !== undefined && (
        <div data-testid="audit-stale">
          <Alert
            variant="amber"
            assertive={false}
            title="This history may be out of date"
            description={`Refreshing failed: ${errorMessageOf(error, 'the request did not complete')}. The rows below are the last answer that arrived.`}
          />
        </div>
      )}

      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head className="w-8" />
            {COLUMNS.map((column) => (
              <Table.Head key={column.label} className={column.className}>
                {column.label}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {events.map((event) => (
            <AuditRow
              key={event.eventId}
              event={event}
              expanded={expanded === event.eventId}
              onToggleExpand={() => onToggleExpand(event.eventId)}
              onFilterActor={onFilterActor}
            />
          ))}
        </Table.Body>
      </Table>

      {/* Present only when the API found a further event, so neither scrolling
          to the end nor pressing the button asks for a page that comes back
          empty.

          The button is not a fallback for the observer, it is the same action
          reachable a second way. Scrolling is not something a keyboard reaches
          reliably, and a list that only continues on scroll leaves the rest of
          the history behind for anyone driving the page from the keyboard. It
          also carries the loading and failed states, so there is one indicator
          here rather than a spinner beside a control saying the same thing. */}
      {hasNextPage && onLoadMore && (
        <div ref={sentinel} data-testid="audit-more" className="flex justify-center">
          <Button
            variant="tertiary"
            size="sm"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            data-testid="audit-load-more"
          >
            {loadMoreLabel({ isLoadingMore, failed: error !== undefined })}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What the control says, which is also the only place the three states are
 * distinguished for the reader.
 *
 * "Try again" rather than "Load more" after a failure: the notice above says the
 * rows are stale, and a control still reading "Load more" would suggest the
 * history simply continues.
 */
function loadMoreLabel({
  isLoadingMore,
  failed,
}: {
  isLoadingMore: boolean;
  failed: boolean;
}): string {
  if (isLoadingMore) return 'Loading';
  return failed ? 'Try again' : 'Load more';
}

interface RowProps {
  event: AuditEvent;
  expanded: boolean;
  onToggleExpand: () => void;
  onFilterActor: (actorId: string) => void;
}

/**
 * One event, and its payload behind a caret.
 *
 * Both halves of a two-phase key event render as their own rows. Collapsing a
 * pair into one line would hide the dangling intent a crash between a vendor
 * call and its local write leaves behind, which is the most operationally
 * interesting row the log can hold.
 */
function AuditRow({ event, expanded, onToggleExpand, onFilterActor }: RowProps) {
  const Caret = expanded ? CaretDownIcon : CaretRightIcon;

  return (
    <>
      <Table.Row
        className="cursor-pointer"
        onClick={onToggleExpand}
        data-testid={`audit-row-${event.eventId}`}
      >
        <Table.Cell className="pr-0 text-zinc-400">
          <button
            type="button"
            aria-label={expanded ? 'Hide details' : 'Show details'}
            aria-expanded={expanded}
            className="rounded-md p-0.5 focus-visible:brand-outline"
            onClick={(clicked) => {
              clicked.stopPropagation();
              onToggleExpand();
            }}
          >
            <Caret size={12} weight="bold" />
          </button>
        </Table.Cell>
        <Table.Cell className="font-medium text-zinc-900">
          {getAuditEventTypeLabel(event.type)}
          {event.phase && <PhaseNote event={event} />}
        </Table.Cell>
        <Table.Cell>
          {event.actor.kind === 'user' ? (
            <button
              type="button"
              className="rounded-md text-left text-zinc-600 underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-zinc-900 focus-visible:brand-outline"
              onClick={(clicked) => {
                clicked.stopPropagation();
                onFilterActor(event.actor.id);
              }}
            >
              {event.actor.email ?? event.actor.id}
            </button>
          ) : (
            <span className="text-zinc-600">{event.actor.kind}</span>
          )}
        </Table.Cell>
        <Table.Cell className="hidden font-mono text-xs text-zinc-500 md:table-cell">
          {event.subject}
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap text-zinc-500">
          {formatDateTime(event.createdAt)}
        </Table.Cell>
      </Table.Row>

      {expanded && (
        <Table.Row className="bg-zinc-50/50 hover:bg-zinc-50/50">
          <Table.Cell colSpan={COLUMNS.length + 1}>
            <AuditDetails event={event} />
          </Table.Cell>
        </Table.Row>
      )}
    </>
  );
}

/** Which half of a two-phase flow this row is, and how it ended. */
function PhaseNote({ event }: { event: AuditEvent }) {
  return (
    <span className="ml-2 text-xs font-normal text-zinc-500">
      {event.phase === 'intent' ? 'started' : (event.outcome ?? 'finished')}
    </span>
  );
}

/**
 * The payload, rendered generically rather than per type.
 *
 * Without it the viewer can say a role changed but not what it changed to, and
 * the reader would have to export a CSV to answer the obvious question. A
 * template per event type would be eleven templates that each have to be
 * remembered when a type is added.
 */
function AuditDetails({ event }: { event: AuditEvent }) {
  const fields = Object.entries(event.details as Record<string, unknown>);

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {fields.map(([field, value]) => (
        <div key={field} className="contents">
          <dt className="text-zinc-500">{humanizeField(field)}</dt>
          <dd className="text-zinc-900">{formatDetailValue(value)}</dd>
        </div>
      ))}
      {event.correlationId && (
        <div className="contents">
          <dt className="text-zinc-500">Correlation</dt>
          <dd className="font-mono text-zinc-900">{event.correlationId}</dd>
        </div>
      )}
      {fields.length === 0 && !event.correlationId && (
        <span className="text-zinc-500">This event carries no further detail.</span>
      )}
    </dl>
  );
}

/** `previousRole` reads as "Previous role". */
function humanizeField(field: string): string {
  const spaced = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A payload value as a reader sees it. `AuditDetailValue` is the marshallable
 * set, so this covers all of it: a nested object or array is shown as its JSON
 * rather than as `[object Object]`.
 */
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
