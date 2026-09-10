import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
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
      planName: 'Pay as you go',
      pricePerTbCents: 499,
      monthlyMinimumCents: 499,
      currentPeriodStart: '2026-08-12T00:00:00Z',
      currentPeriodEnd: '2026-09-12T00:00:00Z',
    },
  };
}

/**
 * An org whose price sales put together in Stripe: a named plan, a floor in the
 * thousands, and no single per-TB rate, because a volume deal steps.
 */
function contractedBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      planName: 'Business',
      monthlyMinimumCents: 250_000,
      currentPeriodEnd: '2026-09-12T00:00:00Z',
    },
  };
}

/**
 * A router around the page, because the help rail links to `/support` and an
 * internal link is the router's `Link`. Same shape as the helper in
 * `QuerySources.test.tsx` and its neighbours.
 */
function renderWithRouter(ui: () => React.JSX.Element) {
  const rootRoute = createRootRoute({ component: ui });
  const supportRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/support',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([supportRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router} />);
}

function renderPage(role: OrgRole = OrgRole.Owner) {
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
    ...renderWithRouter(() => (
      <QueryClientProvider client={client}>
        <BillingPage />
      </QueryClientProvider>
    )),
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

    expect(await screen.findByTestId('plan-name')).toHaveTextContent('No plan');
    expect(screen.getByText('Choose a plan to start storing data')).toBeInTheDocument();

    // The state is still readable from the DOM, without a pill repeating the
    // title beside it.
    const status = screen.getByTestId('subscription-status');
    expect(status).toHaveAttribute('data-status', 'inactive');
    expect(status).toBeEmptyDOMElement();

    // The self-serve path out of the blocked state.
    const cta = container.querySelector('#billing-plan-cta-button');
    expect(cta).not.toBeNull();
    expect(cta).toHaveTextContent('Choose a plan');
  });

  it('does not fetch invoices for an inactive account', async () => {
    // An inactive account may have no Stripe customer to list invoices for.
    mockGetBilling.mockResolvedValue(inactiveBilling());
    renderPage();

    await screen.findByTestId('plan-name');
    expect(mockGetInvoices).not.toHaveBeenCalled();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });

  it('still shows the trial upgrade CTA while trialing', async () => {
    mockGetBilling.mockResolvedValue(trialingBilling());
    const { container } = renderPage();

    await screen.findByText('Free trial');
    const cta = container.querySelector('#billing-plan-cta-button');
    expect(cta).toHaveTextContent('Upgrade');
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
    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Storage usage' })).not.toBeInTheDocument();
  });

  it('keeps the storage bar during the trial, which has a finite allowance', async () => {
    mockGetBilling.mockResolvedValue(trialingBilling());
    renderPage();

    await screen.findByText('Storage');
    expect(screen.getByRole('progressbar', { name: 'Storage usage' })).toBeInTheDocument();
  });
});

describe('BillingPage — an organization on a negotiated price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue({ storage: { usedBytes: 40e12 }, egress: { usedBytes: 2e12 } });
    mockGetInvoices.mockResolvedValue({ invoices: [] });
  });

  it('calls the plan what the contract calls it', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    expect(await screen.findByTestId('plan-name')).toHaveTextContent('Business');
  });

  it('says custom pricing without inventing a rate', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    await screen.findByText('Business');
    // No per-TB figure, because this price has no single one, and no minimum
    // standing in for one either. The renewal shares the line.
    expect(screen.getByTestId('plan-meta')).toHaveTextContent(/^Custom pricing · Renews /);
    expect(screen.queryByText(/\/TB per month/)).not.toBeInTheDocument();
    expect(screen.queryByText(/minimum/)).not.toBeInTheDocument();
  });

  it('sends the customer to Stripe for the total rather than estimating it', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    await screen.findByText('Business');
    expect(screen.getByTestId('cost-follows-agreement')).toBeInTheDocument();
    expect(screen.queryByTestId('estimated-cost')).not.toBeInTheDocument();
  });

  it('reads no card on a billed account as invoiced, not as missing', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    expect(await screen.findByTestId('billed-by-invoice')).toBeInTheDocument();
    expect(screen.queryByText('No card on file')).not.toBeInTheDocument();
  });

  it('does not pitch a plan at an organization that already has one', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    await screen.findByText('Business');
    expect(screen.queryByRole('button', { name: 'Talk to sales' })).not.toBeInTheDocument();
  });

  it('points at Stripe for invoices older than the ones listed', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    mockGetInvoices.mockResolvedValue({
      invoices: [
        {
          id: 'in_1',
          amountDueInCents: 250_000,
          status: 'paid',
          createdAt: '2026-07-01T00:00:00Z',
          invoicePdfUrl: null,
        },
      ],
    });
    renderPage();

    expect(await screen.findByRole('button', { name: /View all/ })).toBeInTheDocument();
  });

  it('keeps the archive link from a caller who cannot open the portal', async () => {
    // The portal is `billing.manage`; an Admin reading invoices does not hold it.
    mockGetBilling.mockResolvedValue(contractedBilling());
    mockGetInvoices.mockResolvedValue({
      invoices: [
        {
          id: 'in_1',
          amountDueInCents: 250_000,
          status: 'paid',
          createdAt: '2026-07-01T00:00:00Z',
          invoicePdfUrl: null,
        },
      ],
    });
    renderPage(OrgRole.Admin);

    await screen.findByTestId('plan-name');
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
  });

  it('keeps a route to support beside the figures', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage();

    const support = await screen.findByRole('link', { name: 'Contact support' });
    expect(support).toHaveAttribute('href', '/support');
  });

  it('offers sales to a trial, which has not bought anything yet', async () => {
    mockGetBilling.mockResolvedValue(trialingBilling());
    renderPage();

    await screen.findByText('Free trial');
    expect(screen.getByRole('button', { name: 'Talk to sales' })).toBeInTheDocument();
  });

  it('says which dates the usage figures cover', async () => {
    mockGetBilling.mockResolvedValue(payAsYouGoBilling());
    renderPage();

    expect(await screen.findByTestId('billing-period')).toHaveTextContent(
      /^Aug \d+ – Sep \d+, 2026$/,
    );
  });

  it('estimates from the rate when the price states one', async () => {
    mockGetBilling.mockResolvedValue(payAsYouGoBilling());
    renderPage();

    // 40 TB at $4.99 a TB, and the floor is nowhere near it.
    expect(await screen.findByTestId('estimated-cost')).toHaveTextContent('$199.60');
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
  // The cancellation is stated once, in the banner above the cards. The plan
  // card under it carries the badge and the Reactivate button, not a second
  // copy of the sentence, and the shell states the account's state over every
  // page including this one.
  const CANCELED = 'This subscription is canceled';

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

  it('states it once, in the banner that carries the Reactivate button', async () => {
    const { container } = renderPage(OrgRole.Owner);

    await screen.findByText(CANCELED);
    expect(screen.getAllByText(CANCELED)).toHaveLength(1);
    // Two Reactivate buttons, on purpose: the banner's and the plan card's open
    // the same dialog, so they are named the same thing rather than two.
    expect(screen.getAllByRole('button', { name: 'Reactivate' })).toHaveLength(2);
    expect(container.querySelector('#billing-plan-cta-button')).toHaveTextContent('Reactivate');
  });

  // The banner is information and only its button is a permission: an Admin
  // still reads the state and who to ask, without being offered either of the
  // two controls that would 403.
  it('states it without a control for a caller who cannot reactivate', async () => {
    const { container } = renderPage(OrgRole.Admin);

    await screen.findByText(CANCELED);
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    expect(container.querySelector('#billing-plan-cta-button')).toBeNull();
  });
});
