import type { ComponentType } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { seedPermissions } from '../../lib/test-permissions.js';
import { ToastProvider } from '../../components/Toast/ToastProvider.js';

const mockGetMe = vi.fn();
const mockGetUsage = vi.fn();
const mockGetBilling = vi.fn();
const mockConsumePendingOrgPaymentPrompt = vi.fn();

// The parent route only matters to `createRoute`'s own bookkeeping; the
// component under test never renders through it.
vi.mock('./$orgSlug.js', () => ({ Route: {} }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
      <a href={to}>{children}</a>
    ),
    useParams: () => ({}),
  };
});

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.js')>();
  return {
    ...actual,
    getMe: (...args: unknown[]) => mockGetMe(...args),
    getUsage: (...args: unknown[]) => mockGetUsage(...args),
    getBilling: (...args: unknown[]) => mockGetBilling(...args),
  };
});

vi.mock('../../lib/pending-org-payment-prompt.js', () => ({
  consumePendingOrgPaymentPrompt: (...args: unknown[]) =>
    mockConsumePendingOrgPaymentPrompt(...args),
}));

global.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

import { Route } from './$orgSlug.get-started.js';

const OnboardingRoute = Route.options.component as ComponentType;

const NO_PLAN_BILLING = {
  subscription: { planId: 'unknown', status: 'inactive', currentPeriodEnd: '2026-01-01' },
};

function renderRoute(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <OnboardingRoute />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('$orgSlug/get-started', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockResolvedValue({ orgId: 'org-1' });
    mockGetUsage.mockResolvedValue({ buckets: { count: 0 }, accessKeys: { count: 0 } });
    mockGetBilling.mockResolvedValue(NO_PLAN_BILLING);
  });

  it('opens the payment prompt when a pending stash names this org', async () => {
    mockConsumePendingOrgPaymentPrompt.mockReturnValue(true);

    renderRoute();

    expect(await screen.findByText('Choose your plan')).toBeInTheDocument();
    expect(mockConsumePendingOrgPaymentPrompt).toHaveBeenCalledWith('org-1');
  });

  it('stays quiet with nothing stashed', async () => {
    mockConsumePendingOrgPaymentPrompt.mockReturnValue(false);

    renderRoute();

    await waitFor(() => expect(mockConsumePendingOrgPaymentPrompt).toHaveBeenCalledWith('org-1'));
    expect(screen.queryByText('Choose your plan')).not.toBeInTheDocument();
  });

  it('never opens it for a role without billing.manage', async () => {
    mockConsumePendingOrgPaymentPrompt.mockReturnValue(true);

    renderRoute(OrgRole.Member);

    await screen.findByText('Create bucket');
    expect(mockConsumePendingOrgPaymentPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText('Choose your plan')).not.toBeInTheDocument();
  });
});
