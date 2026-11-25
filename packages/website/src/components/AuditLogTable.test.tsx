import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { AuditEvent } from '@filone/shared';

import { AuditLogTable, type AuditLogTableProps } from './AuditLogTable';

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: 'any-event',
    type: 'org.renamed',
    actor: { kind: 'user', id: 'any-user', email: 'any@example.com' },
    orgId: 'any-org',
    subject: 'org:any-org',
    details: {},
    createdAt: '2026-08-15T12:00:00.000Z',
    ttl: 1_800_000_000,
    ...overrides,
  } as AuditEvent;
}

function renderTable(props: Partial<AuditLogTableProps> = {}) {
  const callbacks = { onToggleExpand: vi.fn(), onFilterActor: vi.fn() };
  render(
    <AuditLogTable
      events={[auditEvent()]}
      isPending={false}
      filtered={false}
      expanded={null}
      {...callbacks}
      {...props}
    />,
  );
  return callbacks;
}

describe('AuditLogTable: controls in a row', () => {
  it('expands a row from the button on its event name', () => {
    const { onToggleExpand } = renderTable();

    fireEvent.click(screen.getByRole('button', { name: 'Organization renamed', expanded: false }));

    expect(onToggleExpand).toHaveBeenCalledExactlyOnceWith('any-event');
  });

  it('expands a row clicked outside its controls', () => {
    const { onToggleExpand } = renderTable();

    fireEvent.click(within(screen.getByTestId('audit-row-any-event')).getByText(/Aug 1[45], 2026/));

    expect(onToggleExpand).toHaveBeenCalledExactlyOnceWith('any-event');
  });

  it('filters by the member without also expanding the row', () => {
    const { onToggleExpand, onFilterActor } = renderTable();

    fireEvent.click(screen.getByRole('button', { name: 'Show only events by any@example.com' }));

    expect(onFilterActor).toHaveBeenCalledExactlyOnceWith('any-user');
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('gives every column a header, the caret column included', () => {
    renderTable();

    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toStrictEqual([
      'Event',
      'Member',
      'When',
      'Details',
    ]);
  });
});
