import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, POLICY_ACTIONS } from '@filone/shared';
import type { PolicyActionOrWildcard } from '@filone/shared';

vi.mock('../lib/api.js', () => ({ getMe: vi.fn(() => new Promise(() => {})) }));

import { PolicyActionFields } from './PolicyActionFields.js';
import { seedPermissions } from '../lib/test-permissions.js';

function renderFields(value: PolicyActionOrWildcard[], role: OrgRole = OrgRole.Owner) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  render(
    <QueryClientProvider client={client}>
      <PolicyActionFields value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('PolicyActionFields', () => {
  it('offers every action to an Owner, grouped, plus all actions', () => {
    renderFields([]);

    expect(screen.getByTestId('policy-action-all')).toBeInTheDocument();
    for (const action of POLICY_ACTIONS) {
      expect(screen.getByTestId(`policy-action-${action}`)).toBeInTheDocument();
    }
    expect(screen.getByText('Data protection')).toBeInTheDocument();
  });

  it('hides the retention writes and all actions from an Admin, and prunes them from the selection', () => {
    const onChange = renderFields(['s3:GetObject', 's3:PutObjectRetention'], OrgRole.Admin);

    expect(screen.queryByTestId('policy-action-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-action-s3:PutObjectRetention')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-action-s3:PutObjectLegalHold')).not.toBeInTheDocument();
    expect(screen.getByTestId('policy-action-s3:GetObjectRetention')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(['s3:GetObject']);
  });

  it('collapses to the wildcard and checks every row while it holds', () => {
    const onChange = renderFields(['s3:GetObject']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'All actions' }));
    expect(onChange).toHaveBeenCalledWith(['s3:*']);
  });

  it('shows every row checked and disabled under the wildcard, and clears it from all actions', () => {
    const onChange = renderFields(['s3:*']);

    const read = screen.getByRole('checkbox', { name: 'Read objects' });
    expect(read).toHaveAttribute('aria-checked', 'true');
    expect(read).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'All actions' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('adds and removes single actions', () => {
    const onChange = renderFields(['s3:GetObject']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'List objects' }));
    expect(onChange).toHaveBeenCalledWith(['s3:GetObject', 's3:ListBucket']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
