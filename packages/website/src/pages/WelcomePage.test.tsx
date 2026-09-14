import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { WelcomePage } from './WelcomePage';

const mockUpdateOrg = vi.fn();
const mockGetBilling = vi.fn();

// `updateOrg` and `getBilling` are faked; `errorMessageOf` is the real one, so
// the test exercises the same message the user would read.
vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
    getBilling: (...args: unknown[]) => mockGetBilling(...args),
  };
});

function renderPage(suggestedName = 'Acme') {
  const onNamed = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WelcomePage suggestedName={suggestedName} onNamed={onNamed} />
    </QueryClientProvider>,
  );
  return { onNamed };
}

const field = () => screen.getByLabelText('Organization name');
const submit = () => screen.getByRole('button', { name: 'Create organization' });

describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme' });
    mockGetBilling.mockResolvedValue({
      subscription: { planId: 'free_trial', status: 'trialing' },
    });
  });

  it('starts with the derived name, so the common answer is submit', () => {
    renderPage();
    expect(field()).toHaveValue('Acme');
  });

  it('saves the name and reports back', async () => {
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Storage' });
    const { onNamed } = renderPage();

    fireEvent.change(field(), { target: { value: 'Acme Storage' } });
    fireEvent.click(submit());

    await waitFor(() => expect(mockUpdateOrg).toHaveBeenCalledWith({ name: 'Acme Storage' }));
    await waitFor(() => expect(onNamed).toHaveBeenCalled());
  });

  it('claims the trial before reporting back, so the destination never has to catch up', async () => {
    // `/me`'s own billingActive is a plain read of whatever this claim already
    // wrote — without it running first, the caller would land on
    // `/get-started` to a "no active plan" gate for however long the claim
    // takes to catch up on its own.
    const { onNamed } = renderPage();

    fireEvent.click(submit());

    await waitFor(() => expect(mockGetBilling).toHaveBeenCalled());
    await waitFor(() => expect(onNamed).toHaveBeenCalled());
  });

  it('reports back even when the trial claim itself fails', async () => {
    // A claim that could not be made (or was already spent) is what the
    // destination page's own gate is for — not a reason to strand the caller
    // on the naming step.
    mockGetBilling.mockRejectedValue(new Error('network error'));
    const { onNamed } = renderPage();

    fireEvent.click(submit());

    await waitFor(() => expect(onNamed).toHaveBeenCalled());
  });

  it('refuses a name the schema rejects without calling the API', async () => {
    renderPage('A');

    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it('keeps the caller on the page when saving fails, and says so', async () => {
    mockUpdateOrg.mockRejectedValue(new Error('You cannot rename this organization'));
    const { onNamed } = renderPage();

    fireEvent.click(submit());

    // The refusal the server gave, not a generic apology.
    expect(await screen.findByText('You cannot rename this organization')).toBeInTheDocument();
    expect(onNamed).not.toHaveBeenCalled();
  });

  it('disables the submit on an empty field rather than refusing after a click', () => {
    renderPage();
    fireEvent.change(field(), { target: { value: '' } });
    expect(submit()).toBeDisabled();
  });
});
