import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { WelcomePage, orgInitials } from './WelcomePage';

const mockUpdateOrg = vi.fn();

// Only `updateOrg` is faked: `errorMessageOf` is the real one, so the test
// exercises the same message the user would read.
vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, updateOrg: (...args: unknown[]) => mockUpdateOrg(...args) };
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
const submit = () => screen.getByRole('button', { name: 'Continue' });

describe('orgInitials', () => {
  it('takes one letter from each of the first two words', () => {
    expect(orgInitials('Acme Storage')).toBe('AS');
  });

  it('takes two letters from a single word', () => {
    expect(orgInitials('Acme')).toBe('AC');
  });

  it('is empty for a blank name, so the monogram holds no stale letter', () => {
    expect(orgInitials('   ')).toBe('');
  });
});

describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme' });
  });

  it('starts with the derived name, so the common answer is Continue', () => {
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

  it('disables Continue on an empty field rather than refusing after a click', () => {
    renderPage();
    fireEvent.change(field(), { target: { value: '' } });
    expect(submit()).toBeDisabled();
  });
});
