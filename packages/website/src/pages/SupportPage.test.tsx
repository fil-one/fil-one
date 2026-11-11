import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';

const mockGetMe = vi.fn();
const mockSubmitSupportForm = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, getMe: (...args: unknown[]) => mockGetMe(...args) };
});

vi.mock('../lib/hubspot.js', () => ({
  submitSupportForm: (...args: unknown[]) => mockSubmitSupportForm(...args),
}));

import { SupportPage } from './SupportPage.js';

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SupportPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Render with `/me` already answered, as the app shell leaves it. */
function renderWithAccount(overrides: Partial<MeResponse> = {}) {
  const client = newClient();
  seedPermissions(client, undefined, overrides);
  return renderPage(client);
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function fillCategoryAndMessage() {
  fireEvent.click(screen.getByLabelText('Product issue'));
  type(screen.getByPlaceholderText('How can we help?'), 'any message');
}

function send() {
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

describe('SupportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmitSupportForm.mockResolvedValue(undefined);
  });

  it('shows an error under each missing field and sends nothing', () => {
    renderWithAccount({ email: undefined });

    send();

    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a category.')).toBeInTheDocument();
    expect(screen.getByText('Tell us how we can help.')).toBeInTheDocument();
    expect(mockSubmitSupportForm).not.toHaveBeenCalled();
  });

  it('treats a message of only spaces as missing', () => {
    renderWithAccount();

    fireEvent.click(screen.getByLabelText('Product issue'));
    type(screen.getByPlaceholderText('How can we help?'), '   ');
    send();

    expect(screen.getByText('Tell us how we can help.')).toBeInTheDocument();
    expect(mockSubmitSupportForm).not.toHaveBeenCalled();
  });

  it.each([
    // Nothing after the @
    'any@',
    // No @ at all
    'any',
    // No domain before the dot
    'any@.com',
  ])('rejects the typed email %s and sends nothing', (email) => {
    renderWithAccount({ email: undefined });

    type(screen.getByPlaceholderText('you@example.com'), email);
    fillCategoryAndMessage();
    send();

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(mockSubmitSupportForm).not.toHaveBeenCalled();
  });

  it('sends the account email, name and organization with the message', () => {
    renderWithAccount({
      email: 'any@example.com',
      name: 'any name',
      orgName: 'any-org',
      orgId: 'any-org-id',
    });

    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
    fillCategoryAndMessage();
    send();

    expect(mockSubmitSupportForm).toHaveBeenCalledWith({
      name: 'any name',
      organization: { name: 'any-org', id: 'any-org-id' },
      email: 'any@example.com',
      categories: ['PRODUCT_ISSUE'],
      message: 'any message',
    });
  });

  it('sends the typed email for an account without one', () => {
    renderWithAccount({ email: undefined });

    type(screen.getByPlaceholderText('you@example.com'), ' typed@example.com ');
    fillCategoryAndMessage();
    send();

    expect(mockSubmitSupportForm).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'typed@example.com' }),
    );
  });

  it('asks for an email and sends without the profile when the profile fails to load', async () => {
    mockGetMe.mockRejectedValue(new Error('any failure'));
    renderPage(newClient());

    const emailInput = await screen.findByPlaceholderText('you@example.com');
    type(emailInput, 'typed@example.com');
    fillCategoryAndMessage();
    send();

    expect(mockSubmitSupportForm).toHaveBeenCalledWith({
      name: undefined,
      organization: undefined,
      email: 'typed@example.com',
      categories: ['PRODUCT_ISSUE'],
      message: 'any message',
    });
  });

  it('keeps the email field and Send while a failed profile is fetched again', async () => {
    mockGetMe.mockRejectedValue(new Error('any failure'));
    const client = newClient();
    renderPage(client);
    await screen.findByPlaceholderText('you@example.com');

    // A fetch that never settles holds the query in its refetching state.
    mockGetMe.mockReturnValue(new Promise(() => {}));
    void client.refetchQueries({ queryKey: queryKeys.me });

    await waitFor(() => expect(mockGetMe).toHaveBeenCalledTimes(2));
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });

  it('keeps Send disabled while the profile is loading', () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage(newClient());

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('clears the form once the message is sent', async () => {
    renderWithAccount();

    fillCategoryAndMessage();
    send();

    await waitFor(() => expect(screen.getByPlaceholderText('How can we help?')).toHaveValue(''));
    expect(screen.getByLabelText('Product issue')).not.toBeChecked();
  });

  it('keeps what the user typed when sending fails', async () => {
    mockSubmitSupportForm.mockRejectedValue(new Error('any failure'));
    renderWithAccount();

    fillCategoryAndMessage();
    send();

    expect(
      await screen.findByText('Failed to send message. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('How can we help?')).toHaveValue('any message');
  });
});
