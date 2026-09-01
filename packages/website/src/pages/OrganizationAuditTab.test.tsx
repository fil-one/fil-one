import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function page(events: AuditEvent[], clamped = false): ListAuditEventsResponse {
  return {
    events,
    window: { from: '2026-05-17T12:00:00.000Z', to: '2026-08-15T12:00:00.000Z', clamped },
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

  // Admin holds audit.view and audit.export; the button is gated on the second.
  it('offers the download to an Admin', async () => {
    renderTab(OrgRole.Admin);

    expect(await screen.findByTestId('audit-download-csv')).toBeInTheDocument();
  });
});
