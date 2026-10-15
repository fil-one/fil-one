import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

const mockListMembers = vi.fn();
vi.mock('../lib/members-api.js', () => ({ listMembers: () => mockListMembers() }));

import { PolicyPrincipalFields } from './PolicyPrincipalFields.js';

const adaId = '11111111-1111-4111-8111-111111111111';
const benId = '22222222-2222-4222-8222-222222222222';
const removedMemberId = '33333333-3333-4333-8333-333333333333';

const listMembersResponse = {
  members: [
    { userId: adaId, role: OrgRole.Owner, name: 'Ada' },
    { userId: benId, role: OrgRole.Member, email: 'ben@example.com' },
  ],
};

function renderFields(value: string[] | '*', onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PolicyPrincipalFields value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('PolicyPrincipalFields', () => {
  beforeEach(() => {
    mockListMembers.mockReset();
    mockListMembers.mockResolvedValue(listMembersResponse);
  });

  it('lists members by name or email with their role', async () => {
    renderFields([adaId]);

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('ben@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('adds a member when checked', async () => {
    const onChange = renderFields([adaId]);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'ben@example.com' }));
    expect(onChange).toHaveBeenCalledWith([adaId, benId]);
  });

  it('removes a member when unchecked', async () => {
    const onChange = renderFields([adaId]);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Ada' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('toggles a member once when their name is clicked', async () => {
    const onChange = renderFields([adaId]);

    await waitFor(() => expect(screen.getByText('ben@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ben@example.com'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([adaId, benId]);
  });

  it('does not fetch members when everyone is selected', () => {
    renderFields('*');

    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it('clears the selection when switching to specific members', () => {
    const onChange = renderFields('*');

    fireEvent.click(screen.getByRole('radio', { name: 'Specific members' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('keeps a selected member the list no longer has, named as unknown', async () => {
    renderFields([removedMemberId]);

    await waitFor(() => expect(screen.getByText('Unknown member')).toBeInTheDocument());
    expect(screen.getByText(removedMemberId)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Unknown member' })).toBeChecked();
  });

  it('says what to do when members fail to load, and shows no rows', async () => {
    mockListMembers.mockRejectedValue(new Error('members unavailable'));
    renderFields([adaId]);

    await waitFor(() =>
      expect(screen.getByText('The member list could not be loaded.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Unknown member')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows the empty state when the organization has no members', async () => {
    mockListMembers.mockResolvedValue({ members: [] });
    renderFields([]);

    await waitFor(() => expect(screen.getByText('No members yet')).toBeInTheDocument());
  });
});
