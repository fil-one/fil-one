import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';

// Stub the dialogs — they pull in Stripe.js and are not what these tests
// target, matching `BillingPage.test.tsx`'s own reasoning.
vi.mock('./billing/AddPaymentDialog.js', () => ({
  AddPaymentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-payment-dialog" /> : null,
}));
vi.mock('./billing/ContactSalesDialog.js', () => ({
  ContactSalesDialog: () => null,
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn() } }),
}));

const mockGetBilling = vi.fn();
const mockGetUsage = vi.fn();
const mockGetInvoices = vi.fn();
const mockApiRequest = vi.fn();
vi.mock('../lib/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getBilling: (...args: unknown[]) => mockGetBilling(...args),
  getUsage: (...args: unknown[]) => mockGetUsage(...args),
  getInvoices: (...args: unknown[]) => mockGetInvoices(...args),
}));

import { BillingRequiredGate } from './BillingRequiredGate.js';

function renderGate(role: OrgRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, { billingActive: false });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <BillingRequiredGate />
      </QueryClientProvider>,
    ),
  };
}

describe('BillingRequiredGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue({ storage: { usedBytes: 0 }, egress: { usedBytes: 0 } });
    mockGetBilling.mockResolvedValue({ subscription: { planId: 'none', status: 'inactive' } });
    mockGetInvoices.mockResolvedValue({ invoices: [] });
    mockApiRequest.mockResolvedValue({
      clientSecret: 'seti_test_secret',
      stripePublishableKey: 'pk_test',
    });
  });

  it('offers an Owner a CTA straight to the card form, no plan choice in between', async () => {
    renderGate(OrgRole.Owner);

    expect(await screen.findByText('Add a payment method to continue')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Add payment method' });
    expect(cta).toBeInTheDocument();

    cta.click();
    expect(await screen.findByTestId('add-payment-dialog')).toBeInTheDocument();
  });

  it('also offers an Owner a way to talk to sales instead', async () => {
    renderGate(OrgRole.Owner);

    const link = await screen.findByRole('button', { name: 'Talk to sales instead' });
    expect(link).toBeInTheDocument();
  });

  it('tells an Admin to ask the Owner too — billing.manage is Owner-only', async () => {
    renderGate(OrgRole.Admin);

    expect(await screen.findByText(/Ask an Owner to add a payment method/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add payment method' })).not.toBeInTheDocument();
  });

  it('tells a Member to ask an Owner, with no CTA that would 403', async () => {
    renderGate(OrgRole.Member);

    expect(await screen.findByText(/Ask an Owner to add a payment method/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add payment method' })).not.toBeInTheDocument();
  });

  it('tells a ReadOnly member the same thing', async () => {
    renderGate(OrgRole.ReadOnly);

    expect(await screen.findByText(/Ask an Owner to add a payment method/)).toBeInTheDocument();
  });

  it('invalidates /me on a billing:updated event, so the gate re-checks itself', async () => {
    const { client } = renderGate(OrgRole.Owner);
    await screen.findByText('Add a payment method to continue');
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    window.dispatchEvent(new CustomEvent('billing:updated'));

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me'] }));
  });
});
