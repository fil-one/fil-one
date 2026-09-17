import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import { AUDIT_EVENT_TYPES, AUDIT_EVENT_TYPE_LABELS } from '@filone/shared';
import type { AuditEventType } from '@filone/shared';

import { Alert } from '../components/Alert';
import { AuditLogTable } from '../components/AuditLogTable';
import { Button } from '../components/Button';
import { RequirePermission } from '../components/RequirePermission';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import {
  auditCsvFilename,
  auditQueryParams,
  downloadAuditCsv,
  EMPTY_AUDIT_FILTERS,
  hasAuditFilters,
  listAuditEvents,
} from '../lib/audit-api.js';
import type { AuditFilterState } from '../lib/audit-api.js';
import { downloadBlob } from '../lib/download.js';
import { errorMessageOf } from '../lib/api.js';
import { listMembers } from '../lib/members-api.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { memberName } from '../lib/use-member-scope.js';

/**
 * The organization's recorded history.
 *
 * Distinct from the dashboard's activity feed, which is synthesized from what
 * exists now and readable by every role. This is what was written down as it
 * happened, and only Owner and Admin may read it.
 */
export function OrganizationAuditTab() {
  const [filters, setFilters] = useState<AuditFilterState>(EMPTY_AUDIT_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Paged rather than a single read: an org's history runs past one page, and an
  // auditor's whole task is reaching an old event. The cursor is the page param
  // and so stays out of the query key, which names the filters alone — changing
  // a filter starts a new history rather than appending to the old one.
  const params = auditQueryParams(filters).toString();
  const history = useInfiniteQuery({
    queryKey: queryKeys.auditEvents(params),
    queryFn: ({ pageParam }) => listAuditEvents(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    // The API offers a cursor only when it found a further event, so this never
    // asks for a page that comes back empty.
    getNextPageParam: (last) => last.nextCursor,
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
  });

  const events = history.data?.pages.flatMap((page) => page.events);
  // The window is a property of the range asked for, not of a page, so the
  // first answer speaks for all of them.
  const window = history.data?.pages[0]?.window;

  // The picker names people; the request carries ids. Shares the roster query
  // the Members tab already fills, so opening this tab adds no request.
  const roster = useQuery({
    queryKey: queryKeys.members,
    queryFn: listMembers,
    staleTime: LIST_STALE_TIME,
  });

  function update(patch: Partial<AuditFilterState>) {
    setFilters((current) => ({ ...current, ...patch }));
    setExpanded(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <AuditFilters
        filters={filters}
        members={roster.data?.members ?? []}
        onChange={update}
        onClear={() => setFilters(EMPTY_AUDIT_FILTERS)}
      />

      {window?.clamped && (
        <Alert
          variant="amber"
          assertive={false}
          description="Some of the range you asked for is older than the 90 day retention period, so those events have been removed."
        />
      )}

      <AuditLogTable
        events={events}
        isPending={history.isPending}
        error={history.isError ? history.error : undefined}
        filtered={hasAuditFilters(filters)}
        expanded={expanded}
        onToggleExpand={(eventId) => setExpanded((open) => (open === eventId ? null : eventId))}
        onFilterActor={(actorId) => update({ actorId })}
        hasNextPage={history.hasNextPage}
        isLoadingMore={history.isFetchingNextPage}
        onLoadMore={() => void history.fetchNextPage()}
      />
    </div>
  );
}

interface FiltersProps {
  filters: AuditFilterState;
  members: { userId: string; name?: string; email?: string }[];
  onChange: (patch: Partial<AuditFilterState>) => void;
  onClear: () => void;
}

/**
 * Dates, one event type, one member, and the download.
 *
 * One event type rather than several, which is what the API indexes: naming two
 * would fall back to scanning the whole window and filtering, and the
 * investigator's first question is usually one kind of change.
 */
function AuditFilters({ filters, members, onChange, onClear }: FiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <DateField
        label="From"
        value={filters.from}
        max={filters.to || undefined}
        onChange={(from) => onChange({ from })}
      />
      <DateField
        label="To"
        value={filters.to}
        min={filters.from || undefined}
        onChange={(to) => onChange({ to })}
      />

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-600">Event</span>
        <Select
          aria-label="Filter by event type"
          selectSize="sm"
          value={filters.eventType}
          onChange={(eventType) => onChange({ eventType: eventType as AuditEventType | '' })}
        >
          <option value="">All events</option>
          {AUDIT_EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {AUDIT_EVENT_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-600">Member</span>
        <Select
          aria-label="Filter by member"
          selectSize="sm"
          value={filters.actorId}
          onChange={(actorId) => onChange({ actorId })}
        >
          <option value="">Anyone</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {memberName(member)}
            </option>
          ))}
        </Select>
      </label>

      {hasAuditFilters(filters) && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      )}

      <div className="ml-auto">
        <RequirePermission permission="audit.export">
          <DownloadCsvButton filters={filters} />
        </RequirePermission>
      </div>
    </div>
  );
}

interface DateFieldProps {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}

/**
 * A day, which the API client widens into an instant.
 *
 * The native control rather than a new picker: the console has no date picker,
 * and a range of two days does not justify introducing one.
 */
function DateField({ label, value, min, max, onChange }: DateFieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-600">{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-md border border-(--input-border-color) bg-white px-2.5 text-[13px] text-(--color-text-base) transition-colors focus-visible:brand-outline"
      />
    </label>
  );
}

function DownloadCsvButton({ filters }: { filters: AuditFilterState }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      downloadBlob(await downloadAuditCsv(filters), auditCsvFilename(filters));
    } catch (err) {
      // The API refuses an export it cannot fit in one response rather than
      // truncating it, and the message it sends names the remedy.
      toast.error(errorMessageOf(err, 'The audit log could not be exported.'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      variant="tertiary"
      size="sm"
      icon={DownloadSimpleIcon}
      disabled={downloading}
      onClick={() => void download()}
      data-testid="audit-download-csv"
    >
      {downloading ? 'Preparing' : 'Download CSV'}
    </Button>
  );
}
