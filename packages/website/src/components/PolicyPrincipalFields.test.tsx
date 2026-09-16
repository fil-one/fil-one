import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

const mockListMembers = vi.fn();
vi.mock('../lib/members-api.js', () => ({ listMembers: () => mockListMembers() }));

import { PolicyPrincipalFields } from './PolicyPrincipalFields.js';

const roster = {
  members: [
    { userId: 'a', role: OrgRole.Owner, name: 'Ada' },
    { userId: 'b', role: OrgRole.Member, email: 'ben@example.com' },
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
    mockListMembers.mockResolvedValue(roster);
  });

  it('lists the roster by name and role and toggles a member', async () => {
    const onChange = renderFields(['a']);

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('ben@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'ben@example.com' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ada' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('reads no roster for everyone, and switches between the two', () => {
    const onChange = renderFields('*');
    expect(mockListMembers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'Specific members' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('keeps a selected member the roster no longer lists, named as unknown', async () => {
    renderFields(['gone']);

    await waitFor(() => expect(screen.getByText('Unknown member')).toBeInTheDocument());
    expect(screen.getByText('gone')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Unknown member' })).toBeChecked();
  });

  it('says when the roster could not be read', async () => {
    mockListMembers.mockRejectedValue(new Error('roster unavailable'));
    renderFields([]);

    await waitFor(() => expect(screen.getByText('roster unavailable')).toBeInTheDocument());
  });
});
