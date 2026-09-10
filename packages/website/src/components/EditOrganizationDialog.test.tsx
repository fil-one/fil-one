import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { ToastProvider } from './Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { EditOrganizationDialog } from './EditOrganizationDialog.js';

const mockUpdateOrg = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, updateOrg: (...args: unknown[]) => mockUpdateOrg(...args) };
});

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, {
    orgName: 'Acme',
    memberships: [{ orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }],
  });
  return {
    client,
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EditOrganizationDialog open onClose={onClose} orgName="Acme" />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

describe('EditOrganizationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
  });

  it('opens on the name the org already has, with nothing to save', async () => {
    renderDialog();

    expect(await screen.findByLabelText('Organization name')).toHaveValue('Acme');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a rename and writes it everywhere the name is read', async () => {
    const { client, onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateOrg).toHaveBeenCalledWith({ name: 'Acme Two' }));
    // The switcher reads the name from `memberships`, so patching only
    // `orgName` would rename the header and leave the switcher stale.
    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgName: 'Acme Two',
        memberships: [{ orgId: 'org-1', orgName: 'Acme Two' }],
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'no/slashes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it('keeps a refusal in the dialog rather than closing over it', async () => {
    mockUpdateOrg.mockRejectedValue(new Error('You cannot rename this organization'));
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The name is still in the field to try again with.
    expect(await screen.findByText('You cannot rename this organization')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
