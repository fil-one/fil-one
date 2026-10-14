import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { PolicyStatement } from '@filone/shared';

vi.mock('../lib/api.js', () => ({ getMe: vi.fn(() => new Promise(() => {})) }));
vi.mock('../lib/members-api.js', () => ({
  listMembers: () =>
    Promise.resolve({ members: [{ userId: 'a', role: OrgRole.Member, name: 'Ada' }] }),
}));

import { PolicyStatementModal, isDenyForEveryone } from './PolicyStatementModal.js';
import { seedPermissions } from '../lib/test-permissions.js';

function renderModal(
  props: Partial<React.ComponentProps<typeof PolicyStatementModal>> = {},
  role: OrgRole = OrgRole.Owner,
) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  render(
    <QueryClientProvider client={client}>
      <PolicyStatementModal open onClose={onClose} onSubmit={onSubmit} {...props} />
    </QueryClientProvider>,
  );
  return { onSubmit, onClose };
}

function pickEveryoneAndReadObjects() {
  fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
}

describe('PolicyStatementModal', () => {
  it('disables Add statement until a principal and an action are picked', () => {
    renderModal();
    const submit = screen.getByRole('button', { name: 'Add statement' });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    expect(submit).toBeEnabled();
  });

  it('shows the missing principal error', () => {
    renderModal();

    expect(screen.getByText('Pick at least one member, or everyone.')).toBeInTheDocument();
  });

  it('shows the missing action error', () => {
    renderModal();

    expect(screen.getByText('Pick at least one action.')).toBeInTheDocument();
  });

  it('submits the statement and closes', () => {
    const { onSubmit, onClose } = renderModal();
    pickEveryoneAndReadObjects();
    fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));

    expect(onSubmit).toHaveBeenCalledWith({
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
    } satisfies PolicyStatement);
    expect(onClose).toHaveBeenCalled();
  });

  it('submits an unchanged edited statement as it was', async () => {
    const initial: PolicyStatement = {
      Sid: 'team',
      Effect: 'Deny',
      Principal: ['a'],
      Action: ['s3:DeleteObject'],
    };
    const { onSubmit } = renderModal({ initial });

    expect(screen.getByText('Edit statement')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Save statement' }));

    expect(onSubmit).toHaveBeenCalledWith(initial);
  });

  it('trims the name before submitting', () => {
    const { onSubmit } = renderModal();
    pickEveryoneAndReadObjects();
    fireEvent.change(screen.getByLabelText('Name (optional)'), {
      target: { value: '  Analytics team read  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));

    expect(onSubmit).toHaveBeenCalledWith({
      Sid: 'Analytics team read',
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
    } satisfies PolicyStatement);
  });

  it('omits Sid when the name is only spaces', () => {
    const { onSubmit } = renderModal();
    pickEveryoneAndReadObjects();
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));

    expect(onSubmit).toHaveBeenCalledWith({
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
    } satisfies PolicyStatement);
  });

  it('accepts a name with the filone- prefix', () => {
    renderModal();
    pickEveryoneAndReadObjects();
    fireEvent.change(screen.getByLabelText('Name (optional)'), {
      target: { value: 'filone-team' },
    });

    expect(screen.getByRole('button', { name: 'Add statement' })).toBeEnabled();
  });

  it('drops retention writes an Admin cannot see when saving straight away', () => {
    const initial: PolicyStatement = {
      Effect: 'Allow',
      Principal: ['a'],
      Action: ['s3:GetObject', 's3:PutObjectRetention'],
    };
    const { onSubmit } = renderModal({ initial }, OrgRole.Admin);

    expect(screen.queryByTestId('policy-action-s3:PutObjectRetention')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save statement' }));

    expect(onSubmit).toHaveBeenCalledWith({ ...initial, Action: ['s3:GetObject'] });
  });

  it('warns as soon as a deny names everyone', () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: /^Deny/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));

    expect(screen.getByText('This statement denies everyone')).toBeInTheDocument();
  });

  it('shows no warning for an Allow to everyone', () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));

    expect(screen.queryByText('This statement denies everyone')).not.toBeInTheDocument();
  });

  it.each([
    [true, 'a Deny to everyone', { Effect: 'Deny', Principal: '*' }],
    [false, 'an Allow to everyone', { Effect: 'Allow', Principal: '*' }],
    [false, 'a Deny to one member', { Effect: 'Deny', Principal: ['a'] }],
  ] satisfies [boolean, string, Pick<PolicyStatement, 'Effect' | 'Principal'>][])(
    'isDenyForEveryone returns %s for %s',
    (expected, _description, statement) => {
      expect(isDenyForEveryone(statement)).toBe(expected);
    },
  );
});
