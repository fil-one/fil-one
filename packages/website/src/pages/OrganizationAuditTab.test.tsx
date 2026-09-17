import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { AuditEvent, ListAuditEventsResponse, MemberSummary } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { OrganizationAuditTab } from './OrganizationAuditTab.js';

const mockListAuditEvents = vi.fn();
const mockDownloadAuditCsv = vi.fn();

vi.mock('../lib/audit-api.js', async (importOriginal) => {
  // The query-string helpers are pure and are what the assertions read, so the
  // mock replaces only the two calls that reach the network.
  const actual = await importOriginal<typeof import('../lib/audit-api.js')>();
  return {
    ...actual,
    listAuditEvents: (...args: unknown[]) => mockListAuditEvents(...args),
    downloadAuditCsv: (...args: unknown[]) => mockDownloadAuditCsv(...args),
  };
});

const mockListMembers = vi.fn();
vi.mock('../lib/members-api.js', () => ({
  listMembers: () => mockListMembers(),
}));

const mockDownloadBlob = vi.fn();
vi.mock('../lib/download.js', () => ({
  downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
  downloadText: vi.fn(),
}));

/**
 * jsdom implements no `IntersectionObserver`, and the table continues on scroll.
 * A no-op stand-in would leave the paging untestable, so this one keeps the live
 * observers and lets a test put the sentinel on screen.
 *
 * `disconnect` really removes the entry, so a sentinel the component has
 * unmounted cannot be scrolled into view a second time.
 */
interface LiveObserver {
  callback: IntersectionObserverCallback;
  observer: IntersectionObserver;
}

const liveObservers = new Set<LiveObserver>();

class TestIntersectionObserver {
  private readonly entry: LiveObserver;

  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, observer: this as unknown as IntersectionObserver };
  }

  observe(): void {
    liveObservers.add(this.entry);
  }

  unobserve(): void {
    liveObservers.delete(this.entry);
  }

  disconnect(): void {
    liveObservers.delete(this.entry);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;

/** Scroll to the end of the rows, which is what asks for the next page. */
async function reachTheEnd() {
  await act(async () => {
    for (const { callback, observer } of [...liveObservers]) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], observer);
    }
  });
}

const MEMBERS: MemberSummary[] = [
  { userId: 'user-1', role: OrgRole.Owner, name: 'Ada Lovelace', email: 'ada@example.com' },
  { userId: 'user-2', role: OrgRole.Admin, email: 'grace@example.com' },
];

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: 'evt-1',
    type: 'member.role_changed',
    actor: { kind: 'user', id: 'user-1', email: 'ada@example.com' },
    orgId: 'org-1',
    subject: 'user:user-2',
    details: { role: OrgRole.Admin, previousRole: OrgRole.Member },
    createdAt: '2026-08-15T12:00:00.000Z',
    ttl: 1_800_000_000,
    ...overrides,
  } as AuditEvent;
}

function page(events: AuditEvent[], clamped = false, nextCursor?: string): ListAuditEventsResponse {
  return {
    events,
    window: { from: '2026-05-17T12:00:00.000Z', to: '2026-08-15T12:00:00.000Z', clamped },
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function renderTab(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <OrganizationAuditTab />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The filters the most recent history request carried. */
function lastFilters() {
  const calls = mockListAuditEvents.mock.calls;
  return calls[calls.length - 1][0] as Record<string, string>;
}

describe('OrganizationAuditTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveObservers.clear();
    mockListMembers.mockResolvedValue({ members: MEMBERS });
    mockListAuditEvents.mockResolvedValue(page([auditEvent()]));
  });

  // Anchored on the row rather than on its label: the filter dropdown lists
  // every event type, so the label alone matches an option before data loads.
  it('renders an event as a labelled row with its actor and time', async () => {
    renderTab();

    const row = await screen.findByTestId('audit-row-evt-1');
    expect(within(row).getByText('Role changed')).toBeInTheDocument();
    expect(within(row).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(row).getByText(/Aug 1[45], 2026/)).toBeInTheDocument();
  });

  // Without it the viewer can say a role changed but not what it changed to.
  it('shows the payload when a row is expanded', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details' }));

    expect(screen.getByText('Previous role')).toBeInTheDocument();
    expect(screen.getByText(OrgRole.Member)).toBeInTheDocument();
  });

  it('collapses a row that is already open', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));

    expect(screen.queryByText('Previous role')).not.toBeInTheDocument();
  });

  it('filters to one event type', async () => {
    renderTab();
    await screen.findByTestId('audit-row-evt-1');

    fireEvent.change(screen.getByLabelText('Filter by event type'), {
      target: { value: 'key.deleted' },
    });

    await waitFor(() => expect(lastFilters().eventType).toBe('key.deleted'));
  });

  // A departed member is reachable as soon as one of their events is on screen.
  it('filters to an actor when their name in a row is clicked', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('ada@example.com'));

    await waitFor(() => expect(lastFilters().actorId).toBe('user-1'));
  });

  it('names members in the picker and sends their id', async () => {
    renderTab();

    // A member whose profile has no name is listed by their address.
    expect(await screen.findByRole('option', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'grace@example.com' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by member'), { target: { value: 'user-2' } });
    await waitFor(() => expect(lastFilters().actorId).toBe('user-2'));
  });

  // Silently returning a quarter to someone who asked for half a year reads as
  // data loss.
  it('says so when the window was clamped to retention', async () => {
    mockListAuditEvents.mockResolvedValue(page([auditEvent()], true));
    renderTab();

    expect(await screen.findByText(/90 day retention period/)).toBeInTheDocument();
  });

  it('says nothing about retention on an unclamped window', async () => {
    renderTab();
    await screen.findByTestId('audit-row-evt-1');

    expect(screen.queryByText(/90 day retention period/)).not.toBeInTheDocument();
  });

  it('offers what to do next when nothing matched a filter', async () => {
    mockListAuditEvents.mockResolvedValue(page([]));
    renderTab();
    fireEvent.change(await screen.findByLabelText('Filter by event type'), {
      target: { value: 'key.deleted' },
    });

    expect(await screen.findByText('No events match these filters')).toBeInTheDocument();
  });

  it('explains what the log holds when it is empty and unfiltered', async () => {
    mockListAuditEvents.mockResolvedValue(page([]));
    renderTab();

    expect(await screen.findByText('No events yet')).toBeInTheDocument();
  });

  it('renders the failure rather than an empty log', async () => {
    mockListAuditEvents.mockRejectedValue(new Error('Service unavailable'));
    renderTab();

    expect(await screen.findByText('The audit log could not be loaded.')).toBeInTheDocument();
  });

  it('hands the exported file to the browser', async () => {
    const blob = new Blob(['eventId\r\n'], { type: 'text/csv' });
    mockDownloadAuditCsv.mockResolvedValue(blob);
    renderTab();
    fireEvent.click(await screen.findByTestId('audit-download-csv'));

    await waitFor(() => expect(mockDownloadBlob).toHaveBeenCalledWith(blob, 'audit-log.csv'));
  });

  // The API refuses an export it cannot fit in one response, and its message
  // names the remedy, so it has to reach the user rather than be swallowed.
  it('surfaces a refused export', async () => {
    mockDownloadAuditCsv.mockRejectedValue(new Error('This export is over the 20,000 row limit.'));
    renderTab();
    fireEvent.click(await screen.findByTestId('audit-download-csv'));

    expect(await screen.findByText(/over the 20,000 row limit/)).toBeInTheDocument();
  });

  // The org's history runs past one page, and reaching an old event is the whole
  // task. The API offers a cursor only when a further event exists, so the
  // sentinel is there exactly when there is something behind it.
  it('loads the next page as the reader reaches the end', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockResolvedValueOnce(page([auditEvent({ eventId: 'evt-2', subject: 'user:user-9' })]));

    renderTab();
    await screen.findByTestId('audit-row-evt-1');
    await reachTheEnd();

    expect(await screen.findByTestId('audit-row-evt-2')).toBeInTheDocument();
    // Appended, not replaced: the first page stays on screen.
    expect(screen.getByTestId('audit-row-evt-1')).toBeInTheDocument();
    expect(mockListAuditEvents).toHaveBeenLastCalledWith(expect.anything(), 'cursor-1');
  });

  it('stops looking for more once the history ends', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockResolvedValueOnce(page([auditEvent({ eventId: 'evt-2' })]));

    renderTab();
    await screen.findByTestId('audit-row-evt-1');
    await reachTheEnd();
    await screen.findByTestId('audit-row-evt-2');

    expect(screen.queryByTestId('audit-more')).not.toBeInTheDocument();
  });

  it('looks for nothing more when the first page is the whole history', async () => {
    renderTab();
    await screen.findByTestId('audit-row-evt-1');

    expect(screen.queryByTestId('audit-more')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-load-more')).not.toBeInTheDocument();
  });

  // Scrolling is not something a keyboard reaches reliably, so the same action
  // is a control as well. Not a fallback for the observer — both are live.
  it('loads the next page when the control is used instead of scrolling', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockResolvedValueOnce(page([auditEvent({ eventId: 'evt-2' })]));

    renderTab();
    fireEvent.click(await screen.findByTestId('audit-load-more'));

    expect(await screen.findByTestId('audit-row-evt-2')).toBeInTheDocument();
    expect(mockListAuditEvents).toHaveBeenLastCalledWith(expect.anything(), 'cursor-1');
  });

  it('names the control for what it does in each state', async () => {
    mockListAuditEvents.mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'));

    renderTab();

    expect(await screen.findByTestId('audit-load-more')).toHaveTextContent('Load more');
  });

  // What keeps the control and the observer from both fetching the same page:
  // one is disabled and the other held off for as long as a page is in flight.
  it('holds the control while a page is in flight', async () => {
    let deliver: (response: ListAuditEventsResponse) => void = () => {};
    const inFlight = new Promise<ListAuditEventsResponse>((resolve) => {
      deliver = resolve;
    });
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockReturnValueOnce(inFlight);

    renderTab();
    fireEvent.click(await screen.findByTestId('audit-load-more'));

    await waitFor(() => expect(screen.getByTestId('audit-load-more')).toBeDisabled());
    expect(screen.getByTestId('audit-load-more')).toHaveTextContent('Loading');
    // Scrolling while it is in flight adds nothing.
    await reachTheEnd();
    expect(mockListAuditEvents).toHaveBeenCalledTimes(2);

    await act(async () => {
      deliver(page([auditEvent({ eventId: 'evt-2' })]));
    });

    expect(await screen.findByTestId('audit-row-evt-2')).toBeInTheDocument();
  });

  it('asks for each page once, however far the reader scrolls', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockResolvedValueOnce(page([auditEvent({ eventId: 'evt-2' })], false, 'cursor-2'));

    renderTab();
    await screen.findByTestId('audit-row-evt-1');
    await reachTheEnd();
    await screen.findByTestId('audit-row-evt-2');

    // Two reads: the first page and the one the scroll asked for. A sentinel
    // still on screen must not re-ask for a page already in hand.
    expect(mockListAuditEvents).toHaveBeenCalledTimes(2);
  });

  // Retrying on scroll would put a failing request behind every wheel event, so
  // a failed page is the one case the reader drives.
  it('asks rather than retries when a page fails, and says the rows are stale', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockRejectedValueOnce(new Error('Service unavailable'));

    renderTab();
    await screen.findByTestId('audit-row-evt-1');
    await reachTheEnd();

    expect(await screen.findByTestId('audit-stale')).toBeInTheDocument();
    expect(screen.getByTestId('audit-load-more')).toHaveTextContent('Try again');
    // The rows that did arrive stay, rather than the page going blank.
    expect(screen.getByTestId('audit-row-evt-1')).toBeInTheDocument();

    // And scrolling again changes nothing until it is asked for.
    await reachTheEnd();
    expect(mockListAuditEvents).toHaveBeenCalledTimes(2);
  });

  it('takes the failed page again when asked', async () => {
    mockListAuditEvents
      .mockResolvedValueOnce(page([auditEvent()], false, 'cursor-1'))
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockResolvedValueOnce(page([auditEvent({ eventId: 'evt-2' })]));

    renderTab();
    await screen.findByTestId('audit-row-evt-1');
    await reachTheEnd();
    fireEvent.click(await screen.findByTestId('audit-load-more'));

    expect(await screen.findByTestId('audit-row-evt-2')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-stale')).not.toBeInTheDocument();
  });

  it('says nothing about staleness while the history is healthy', async () => {
    renderTab();
    await screen.findByTestId('audit-row-evt-1');

    expect(screen.queryByTestId('audit-stale')).not.toBeInTheDocument();
  });

  // Admin holds audit.view and audit.export; the button is gated on the second.
  it('offers the download to an Admin', async () => {
    renderTab(OrgRole.Admin);

    expect(await screen.findByTestId('audit-download-csv')).toBeInTheDocument();
  });
});
