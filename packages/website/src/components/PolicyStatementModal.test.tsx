import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, buildStatement, toPolicyPrincipal } from '@filone/shared';
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
      <PolicyStatementModal
        open
        bucketName="photos"
        onClose={onClose}
        onSubmit={onSubmit}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onSubmit, onClose };
}

function renderModalWithRerender(
  props: Partial<React.ComponentProps<typeof PolicyStatementModal>> = {},
  role: OrgRole = OrgRole.Owner,
) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const view = render(
    <QueryClientProvider client={client}>
      <PolicyStatementModal open onClose={onClose} onSubmit={onSubmit} {...props} />
    </QueryClientProvider>,
  );
  const rerender = (next: Partial<React.ComponentProps<typeof PolicyStatementModal>>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <PolicyStatementModal open onClose={onClose} onSubmit={onSubmit} {...next} />
      </QueryClientProvider>,
    );
  return { onSubmit, onClose, rerender };
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

  it('shows no error before the user touches a field', () => {
    renderModal();

    expect(screen.queryByText('Pick at least one member, or everyone.')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick at least one action.')).not.toBeInTheDocument();
  });

  it('shows the missing principal error once the principal field was touched', () => {
    renderModal();

    fireEvent.click(screen.getByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Specific members' }));

    expect(screen.getByText('Pick at least one member, or everyone.')).toBeInTheDocument();
  });

  it('shows the missing action error once an action was picked and dropped', () => {
    renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));

    expect(screen.getByText('Pick at least one action.')).toBeInTheDocument();
  });

  it('forgets the edits when the modal closes and reopens', () => {
    const initial = buildStatement({
      bucketName: 'photos',
      principal: '*',
      actions: ['s3:GetObject'],
      sid: 'team',
    });
    const { rerender } = renderModalWithRerender({ initial });
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'edited' } });
    expect(screen.getByLabelText('Name (optional)')).toHaveValue('edited');

    rerender({ initial, open: false });
    rerender({ initial, open: true });

    expect(screen.getByLabelText('Name (optional)')).toHaveValue('team');
  });

  it('opens an empty Add form after an edit', () => {
    const initial = buildStatement({
      bucketName: 'photos',
      principal: '*',
      actions: ['s3:GetObject'],
      sid: 'team',
    });
    const { rerender } = renderModalWithRerender({ initial });

    rerender({ initial, open: false });
    rerender({ initial: undefined, open: true });

    expect(screen.getByLabelText('Name (optional)')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add statement' })).toBeDisabled();
  });

  it('submits the statement and closes', () => {
    const { onSubmit, onClose } = renderModal();
    pickEveryoneAndReadObjects();
    fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));

    expect(onSubmit).toHaveBeenCalledWith({
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::photos/*'],
    } satisfies PolicyStatement);
    expect(onClose).toHaveBeenCalled();
  });

  it('submits an unchanged edited statement as it was', async () => {
    const initial = buildStatement({
      bucketName: 'photos',
      effect: 'Deny',
      principal: ['a'],
      actions: ['s3:DeleteObject'],
      sid: 'team',
    });
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
      Resource: ['arn:aws:s3:::photos/*'],
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
      Resource: ['arn:aws:s3:::photos/*'],
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

  it('keeps the retention writes an Owner granted when an Admin saves', () => {
    const initial = buildStatement({
      bucketName: 'photos',
      principal: ['a'],
      actions: ['s3:GetObject', 's3:PutObjectRetention'],
    });
    const { onSubmit } = renderModal({ initial }, OrgRole.Admin);

    expect(screen.getByTestId('policy-action-s3:PutObjectRetention')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save statement' }));

    expect(onSubmit).toHaveBeenCalledWith(initial);
  });

  it('offers an Admin no retention write to add', () => {
    renderModal(
      {
        initial: buildStatement({
          bucketName: 'photos',
          principal: ['a'],
          actions: ['s3:GetObject'],
        }),
      },
      OrgRole.Admin,
    );

    expect(screen.queryByTestId('policy-action-s3:PutObjectRetention')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-action-s3:PutObjectLegalHold')).not.toBeInTheDocument();
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
    [false, 'a Deny to one member', { Effect: 'Deny', Principal: toPolicyPrincipal(['a']) }],
  ] satisfies [boolean, string, Pick<PolicyStatement, 'Effect' | 'Principal'>][])(
    'isDenyForEveryone returns %s for %s',
    (expected, _description, statement) => {
      expect(isDenyForEveryone(statement)).toBe(expected);
    },
  );
});
