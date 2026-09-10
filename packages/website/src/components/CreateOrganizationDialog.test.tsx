import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CreateOrganizationDialog } from './CreateOrganizationDialog.js';

const mockCreateOrg = vi.fn();
const mockSwitchToOrg = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, createOrg: (...args: unknown[]) => mockCreateOrg(...args) };
});

vi.mock('../lib/active-org.js', () => ({
  switchToOrg: (...args: unknown[]) => mockSwitchToOrg(...args),
}));

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <CreateOrganizationDialog open onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

describe('CreateOrganizationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOrg.mockResolvedValue({
      orgId: 'org-2',
      orgName: 'Acme Two',
      slug: 'acme-two',
      role: 'owner',
    });
  });

  it('opens empty, with a name field and logo picker, and Create disabled with nothing typed', async () => {
    renderDialog();

    expect(await screen.findByLabelText('Organization name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Choose avatar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeEnabled();
  });

  it('creates the org, switches into it landing on get-started, and closes', async () => {
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() =>
      expect(mockCreateOrg).toHaveBeenCalledWith({ name: 'Acme Two', logoUrl: undefined }),
    );
    // The response's own slug is passed so the switch skips a second redirect,
    // and get-started is the landing since the new org is empty.
    await waitFor(() =>
      expect(mockSwitchToOrg).toHaveBeenCalledWith('org-2', 'acme-two', 'get-started'),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'no/slashes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockCreateOrg).not.toHaveBeenCalled();
    expect(mockSwitchToOrg).not.toHaveBeenCalled();
  });

  it('keeps a server refusal in the dialog rather than closing over it', async () => {
    mockCreateOrg.mockRejectedValue(new Error('You have reached the organization limit'));
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('You have reached the organization limit')).toBeInTheDocument();
    expect(mockSwitchToOrg).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
