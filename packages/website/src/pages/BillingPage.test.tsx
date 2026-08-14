import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo } from '@filone/shared';

// Stub the dialogs — they pull in Stripe.js and are not what these tests target.
vi.mock('../components/billing/ChoosePlanDialog.js', () => ({
  ChoosePlanDialog: () => null,
}));
vi.mock('../components/billing/AddPaymentDialog.js', () => ({
  AddPaymentDialog: () => null,
}));
vi.mock('../components/billing/ContactSalesDialog.js', () => ({
  ContactSalesDialog: () => null,
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn() } }),
}));

const mockGetBilling = vi.fn();
const mockGetUsage = vi.fn();
const mockGetInvoices = vi.fn();
vi.mock('../lib/api.js', () => ({
  apiRequest: vi.fn(),
  getBilling: (...args: unknown[]) => mockGetBilling(...args),
  getUsage: (...args: unknown[]) => mockGetUsage(...args),
  getInvoices: (...args: unknown[]) => mockGetInvoices(...args),
  activateSubscription: vi.fn(),
}));

import { BillingPage } from './BillingPage.js';

const USAGE = {
  storage: { usedBytes: 0 },
  egress: { usedBytes: 0 },
};

function inactiveBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.None,
      status: SubscriptionStatus.Inactive,
    },
  };
}

function trialingBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.FreeTrial,
      status: SubscriptionStatus.Trialing,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BillingPage />
    </QueryClientProvider>,
  );
}

describe('BillingPage — inactive subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue(USAGE);
    mockGetInvoices.mockResolvedValue({ invoices: [] });
  });

  it('shows the no-active-plan state with a "Choose a plan" CTA', async () => {
    mockGetBilling.mockResolvedValue(inactiveBilling());
    const { container } = renderPage();

    expect(await screen.findByText('No active plan')).toBeInTheDocument();
    expect(screen.getByText('Choose a plan to start storing data')).toBeInTheDocument();

    // The status badge is never empty for an inactive account.
    const status = screen.getByTestId('subscription-status');
    expect(status).toHaveAttribute('data-status', 'inactive');
    expect(status).toHaveTextContent('No plan');

    // The self-serve path out of the blocked state.
    const cta = container.querySelector('#billing-plan-cta-button');
    expect(cta).not.toBeNull();
    expect(cta).toHaveTextContent('Choose a plan');
  });

  it('does not fetch invoices for an inactive account', async () => {
    // An inactive account may have no Stripe customer to list invoices for.
    mockGetBilling.mockResolvedValue(inactiveBilling());
    renderPage();

    await screen.findByText('No active plan');
    expect(mockGetInvoices).not.toHaveBeenCalled();
    expect(screen.queryByText('Invoice history')).not.toBeInTheDocument();
  });

  it('still shows the trial upgrade CTA while trialing', async () => {
    mockGetBilling.mockResolvedValue(trialingBilling());
    const { container } = renderPage();

    await screen.findByText('Free trial');
    const cta = container.querySelector('#billing-plan-cta-button');
    expect(cta).toHaveTextContent('Upgrade now');
    expect(mockGetInvoices).not.toHaveBeenCalled();
  });
});
