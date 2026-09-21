import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROSTER_OWNERS_SID } from '@filone/shared';
import type { PolicyStatement } from '@filone/shared';

vi.mock('../lib/api.js', () => ({ getMe: vi.fn(() => new Promise(() => {})) }));
vi.mock('../lib/members-api.js', () => ({
  listMembers: () =>
    Promise.resolve({ members: [{ userId: 'a', role: OrgRole.Member, name: 'Ada' }] }),
}));

import { PolicyStatementModal, deniesEveryone } from './PolicyStatementModal.js';
import { seedPermissions } from '../lib/test-permissions.js';

function renderModal(props: Partial<React.ComponentProps<typeof PolicyStatementModal>> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  render(
    <QueryClientProvider client={client}>
      <PolicyStatementModal open onClose={onClose} onSubmit={onSubmit} {...props} />
    </QueryClientProvider>,
  );
  return { onSubmit, onClose };
}

describe('PolicyStatementModal', () => {
  it('refuses an empty statement and hands back a complete one', async () => {
    const { onSubmit, onClose } = renderModal();
    const submit = screen.getByRole('button', { name: 'Add statement' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('Pick at least one member, or everyone.')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one action.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({
      effect: 'allow',
      principal: '*',
      action: ['s3:GetObject'],
    } satisfies PolicyStatement);
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from the statement being edited and keeps its label', async () => {
    const initial: PolicyStatement = {
      sid: 'team',
      effect: 'deny',
      principal: ['a'],
      action: ['s3:DeleteObject'],
    };
    const { onSubmit } = renderModal({ initial });

    expect(screen.getByText('Edit statement')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Save statement' }));

    expect(onSubmit).toHaveBeenCalledWith(initial);
  });

  it('carries a name it was given and drops one cleared to nothing', async () => {
    const { onSubmit } = renderModal();
    const name = screen.getByLabelText('Name (optional)');

    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    fireEvent.change(name, { target: { value: '  Analytics team read  ' } });
    const submit = screen.getByRole('button', { name: 'Add statement' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(submit);

    expect(onSubmit.mock.calls.flat()).toEqual([
      {
        sid: 'Analytics team read',
        effect: 'allow',
        principal: '*',
        action: ['s3:GetObject'],
      },
      { effect: 'allow', principal: '*', action: ['s3:GetObject'] },
    ] satisfies PolicyStatement[]);
  });

  it('refuses a name reserved for the statements Fil One writes', () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    fireEvent.change(screen.getByLabelText('Name (optional)'), {
      target: { value: 'filone-owners' },
    });

    expect(
      screen.getByText(
        'Names starting with "filone-" are reserved for statements Fil One manages.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add statement' })).toBeDisabled();
  });

  it('shows a roster statement its label and will not let it be renamed', async () => {
    const initial: PolicyStatement = {
      sid: ROSTER_OWNERS_SID,
      effect: 'allow',
      principal: ['a'],
      action: ['s3:*'],
    };
    const { onSubmit } = renderModal({ initial });

    const name = screen.getByLabelText('Name (optional)');
    expect(name).toHaveValue('Owners');
    expect(name).toBeDisabled();

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Save statement' }));

    expect(onSubmit).toHaveBeenCalledWith(initial);
  });

  it('warns as soon as a deny names everyone', () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: /^Deny/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));

    expect(screen.getByText('This statement denies everyone')).toBeInTheDocument();
    expect(deniesEveryone({ effect: 'deny', principal: '*' })).toBe(true);
    expect(deniesEveryone({ effect: 'allow', principal: '*' })).toBe(false);
  });
});
