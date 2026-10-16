import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  it.each(POLICY_ACTIONS)('offers %s to an Owner', (action) => {
    renderFields([]);

    expect(screen.getByTestId(`policy-action-${action}`)).toBeInTheDocument();
  });

  it('offers the all actions row to an Owner', () => {
    renderFields([]);

    expect(screen.getByRole('checkbox', { name: 'All actions' })).toBeInTheDocument();
  });

  it('shows the Manage data protection group heading', () => {
    renderFields([]);

    expect(screen.getByText('Manage data protection')).toBeInTheDocument();
  });

  it.each(['All actions', 'Set retention', 'Set legal hold'])('hides %s from an Admin', (label) => {
    renderFields([], OrgRole.Admin);

    expect(screen.queryByRole('checkbox', { name: label })).not.toBeInTheDocument();
  });

  it('still offers Read retention settings to an Admin', () => {
    renderFields([], OrgRole.Admin);

    expect(screen.getByRole('checkbox', { name: 'Read retention settings' })).toBeInTheDocument();
  });

  it("keeps the retention writes an Admin's selection already carries and offers removing them", () => {
    const onChange = renderFields(['s3:GetObject', 's3:PutObjectRetention'], OrgRole.Admin);

    expect(onChange).not.toHaveBeenCalled();
    const retention = screen.getByTestId('policy-action-s3:PutObjectRetention');
    expect(within(retention).getByRole('checkbox')).toBeChecked();

    fireEvent.click(retention);
    expect(onChange).toHaveBeenCalledWith(['s3:GetObject']);
  });

  it('offers an Admin no retention write their selection lacks', () => {
    renderFields(['s3:GetObject'], OrgRole.Admin);

    expect(screen.queryByTestId('policy-action-s3:PutObjectRetention')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-action-s3:PutObjectLegalHold')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-action-all')).not.toBeInTheDocument();
  });

  it("keeps s3:* an Admin's selection already carries", () => {
    const onChange = renderFields(['s3:*'], OrgRole.Admin);

    expect(onChange).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('policy-action-all')).getByRole('checkbox')).toBeChecked();
  });

  it('gives an Admin who picks every offered action the list, never s3:*', () => {
    const offered = POLICY_ACTIONS.filter(
      (action) => action !== 's3:PutObjectRetention' && action !== 's3:PutObjectLegalHold',
    );
    const lastAction = offered[offered.length - 1]!;
    const onChange = renderFields(
      offered.filter((action) => action !== lastAction),
      OrgRole.Admin,
    );

    fireEvent.click(screen.getByTestId(`policy-action-${lastAction}`));
    expect(onChange).toHaveBeenCalledWith(offered);
  });

  it('changes nothing while the permissions are still loading', () => {
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PolicyActionFields value={['s3:GetObject', 's3:PutObjectRetention']} onChange={onChange} />
      </QueryClientProvider>,
    );

    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects s3:* when all actions is clicked', () => {
    const onChange = renderFields(['s3:GetObject']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'All actions' }));
    expect(onChange).toHaveBeenCalledWith(['s3:*']);
  });

  it.each(POLICY_ACTIONS)('shows %s checked and disabled while s3:* is selected', (action) => {
    renderFields(['s3:*']);

    const checkbox = within(screen.getByTestId(`policy-action-${action}`)).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
  });

  it('clears the selection when all actions is unchecked', () => {
    const onChange = renderFields(['s3:*']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'All actions' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('adds an unselected action', () => {
    const onChange = renderFields(['s3:GetObject']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'List objects' }));
    expect(onChange).toHaveBeenCalledWith(['s3:GetObject', 's3:ListBucket']);
  });

  it('removes a selected action', () => {
    const onChange = renderFields(['s3:GetObject', 's3:ListBucket']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    expect(onChange).toHaveBeenCalledWith(['s3:ListBucket']);
  });

  it('toggles an action once when its visible text is clicked', () => {
    const onChange = renderFields([]);

    fireEvent.click(screen.getByText('Browse and list objects'));
    expect(onChange.mock.calls).toEqual([[['s3:ListBucket']]]);
  });

  it('toggles an action once when its checkbox is clicked', () => {
    const onChange = renderFields([]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'List objects' }));
    expect(onChange.mock.calls).toEqual([[['s3:ListBucket']]]);
  });

  it('selects s3:* when an Owner picks every action one by one', () => {
    const lastAction = POLICY_ACTIONS[POLICY_ACTIONS.length - 1];
    const onChange = renderFields(POLICY_ACTIONS.filter((action) => action !== lastAction));

    fireEvent.click(screen.getByTestId(`policy-action-${lastAction}`));
    expect(onChange).toHaveBeenCalledWith(['s3:*']);
  });
});
