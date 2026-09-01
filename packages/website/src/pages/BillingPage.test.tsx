import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import { seedPermissions } from '../lib/test-permissions.js';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo } from '@filone/shared';

// Stub the dialogs — they pull in Stripe.js and are not what these tests target.
// They report whether the page asked them to open, which is what the permission
// gate on the dialog state decides.
vi.mock('../components/billing/ChoosePlanDialog.js', () => ({
  ChoosePlanDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="choose-plan-dialog" /> : null,
}));
vi.mock('../components/billing/AddPaymentDialog.js', () => ({
  AddPaymentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-payment-dialog" /> : null,
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
const mockGetMe = vi.fn();
vi.mock('../lib/api.js', () => ({
  apiRequest: vi.fn(),
  getBilling: (...args: unknown[]) => mockGetBilling(...args),
  getUsage: (...args: unknown[]) => mockGetUsage(...args),
  getInvoices: (...args: unknown[]) => mockGetInvoices(...args),
  // `usePermissions` reads `/me`, and every gate on this page goes through it.
  // The mock was missing it, so any refetch of the seeded cache called
  // `undefined` and errored the query — which used to render the denial copy.
  getMe: (...args: unknown[]) => mockGetMe(...args),
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

function payAsYouGoBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
    },
  };
}

function renderPage(role = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page is gated on `billing.view` and its controls on `billing.manage`.
  seedPermissions(client, role);
  mockGetMe.mockResolvedValue({
    orgId: 'org-1',
    orgName: 'Acme',
    emailVerified: true,
    mfaEnrollments: [],
    ragAccess: true,
    userId: 'user-1',
    role,
    permissions: ROLE_PERMISSIONS[role],
  });
  // The client comes back so a test can re-seed it mid-render, which is what a
  // role change under an open dialog looks like.
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <BillingPage />
      </QueryClientProvider>,
    ),
  };
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

describe('BillingPage — current usage meters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue(USAGE);
    mockGetInvoices.mockResolvedValue({ invoices: [] });
  });

  it('shows no storage bar on pay-as-you-go, where storage is unlimited', async () => {
    mockGetBilling.mockResolvedValue(payAsYouGoBilling());
    renderPage();

    // The figure stays; only the bar, which implies a cap, goes away.
    expect(await screen.findByText('Storage used')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Storage usage' })).not.toBeInTheDocument();
  });

  it('keeps the storage bar during the trial, which has a finite allowance', async () => {
    mockGetBilling.mockResolvedValue(trialingBilling());
    renderPage();

    await screen.findByText('Storage used');
    expect(screen.getByRole('progressbar', { name: 'Storage usage' })).toBeInTheDocument();
  });
});

describe('BillingPage — permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue(USAGE);
    mockGetInvoices.mockResolvedValue({ invoices: [] });
    mockGetBilling.mockResolvedValue(trialingBilling());
  });

  it('tells a Member the page is not theirs, without fetching anything', async () => {
    renderPage(OrgRole.Member);

    expect(await screen.findByText(/Billing is managed by your organization/)).toBeInTheDocument();
    expect(mockGetBilling).not.toHaveBeenCalled();
  });

  it('shows an Admin the plan but not the controls that change it', async () => {
    // `billing.view` reads usage and invoices; `billing.manage` is Owner's.
    const { container } = renderPage(OrgRole.Admin);

    await screen.findByText('Free trial');
    expect(container.querySelector('#billing-plan-cta-button')).toBeNull();
    expect(container.querySelector('#billing-upgrade-button')).toBeNull();
  });

  // Hiding the CTA decides only what can be started. An open plan dialog is
  // state the caller chose before the demotion, and the payment dialog behind
  // it can confirm a SetupIntent Stripe has already issued against an
  // `activateSubscription` that then answers 403.
  it('closes an open plan dialog when the caller loses billing.manage', async () => {
    const { container, client } = renderPage(OrgRole.Owner);

    await screen.findByText('Free trial');
    fireEvent.click(container.querySelector('#billing-plan-cta-button')!);
    expect(await screen.findByTestId('choose-plan-dialog')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.Admin));

    await waitFor(() => expect(screen.queryByTestId('choose-plan-dialog')).not.toBeInTheDocument());
  });

  it('shows an Owner the controls', async () => {
    const { container } = renderPage(OrgRole.Owner);

    await screen.findByText('Free trial');
    expect(container.querySelector('#billing-plan-cta-button')).not.toBeNull();
  });
});

describe('BillingPage — a canceled account', () => {
  // The page's own canceled banner, now gone. The shell states it above every
  // page and the plan card states it over the button that acts on it.
  const PAGE_BANNER = /Your account has been canceled/;

  function canceledBilling(): BillingInfo {
    return {
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.Canceled,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue(USAGE);
    mockGetBilling.mockResolvedValue(canceledBilling());
    mockGetInvoices.mockResolvedValue({ invoices: [] });
  });

  it('states it once, in the card that carries the Reactivate button', async () => {
    renderPage(OrgRole.Owner);

    expect(
      await screen.findByText('Reactivate your subscription to regain full access'),
    ).toBeInTheDocument();
    expect(screen.queryByText(PAGE_BANNER)).not.toBeInTheDocument();
  });

  // The Reactivate control is `billing.manage`, so this caller gets neither the
  // card nor a page banner. The shell's banner above them is what says why the
  // account is unusable, on this page as on every other.
  it('adds no page banner for a caller who cannot reactivate', async () => {
    renderPage(OrgRole.Admin);

    await screen.findByTestId('subscription-status');
    expect(screen.queryByText(PAGE_BANNER)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Reactivate your subscription to regain full access'),
    ).not.toBeInTheDocument();
  });
});
