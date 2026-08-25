import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { OrganizationGeneral } from './OrganizationGeneral.js';

const mockUpdateOrg = vi.fn();
const mockGetMe = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    getMe: () => mockGetMe(),
    updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
  };
});

const ME = {
  orgId: 'org-1',
  orgName: 'Acme',
  email: 'ada@example.com',
  emailVerified: true,
  mfaEnrollments: [],
  ragAccess: true,
  memberships: [{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner }],
} as unknown as MeResponse;

function renderGeneral(role = OrgRole.Owner) {
  mockGetMe.mockResolvedValue(ME);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `seedPermissions` writes the `/me` cache this component reads, so the
  // memberships the switcher renders have to be seeded with it.
  seedPermissions(client, role, {
    orgName: 'Acme',
    memberships: [{ orgId: 'org-1', orgName: 'Acme', role }],
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <OrganizationGeneral />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

describe('OrganizationGeneral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
  });

  it('lets a role holding org.rename edit the name', async () => {
    renderGeneral(OrgRole.Admin);

    expect(await screen.findByLabelText('Organization name')).not.toBeDisabled();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'stays visible but read-only for %s',
    async (role) => {
      // The org's name is worth showing — it names where the caller is working.
      // Renaming it is PATCH /api/org, which the server refuses below Admin.
      renderGeneral(role);

      const field = await screen.findByLabelText('Organization name');
      expect(field).toBeDisabled();
      expect(field).toHaveValue('Acme');
      // Nothing to press, rather than a button that would only be refused.
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    },
  );

  it('saves a rename and writes it everywhere the name is read', async () => {
    const { client } = renderGeneral(OrgRole.Owner);

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
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderGeneral(OrgRole.Owner);

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });
});
