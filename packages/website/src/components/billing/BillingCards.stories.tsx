import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { PlanId, SubscriptionStatus, TB_BYTES } from '@filone/shared';
import type { BillingInfo, Invoice, Subscription } from '@filone/shared';

import { Heading } from '../Heading/Heading';
import { BillingHelpRail } from './BillingHelpRail';
import { InvoicesCard } from './InvoicesCard';
import { PaymentMethodCard } from './PaymentMethodCard';
import { PlanCard } from './PlanCard';
import { UsageCard } from './UsageCard';

/**
 * A router around the stories, because the help rail links to `/support` and an
 * internal link is the router's `Link`. Local rather than in
 * `.storybook/preview.tsx`: a router for every story in the console is probably
 * the right end state, but it is a change to shared story infrastructure and
 * this is one file's need.
 */
function WithRouter(Story: React.ComponentType) {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: () => <Story /> });
    const supportRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/support',
      component: () => null,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([supportRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, [Story]);

  return <RouterProvider router={router} />;
}

const meta: Meta = { title: 'Billing/Cards', decorators: [WithRouter] };
export default meta;

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.Active, ...overrides };
}

/** The self-serve price, as `get-billing` reports it. */
const SELF_SERVE = subscription({
  planName: 'Pay as you go',
  pricePerTbCents: 499,
  monthlyMinimumCents: 499,
  currentPeriodStart: '2026-08-12T00:00:00Z',
  currentPeriodEnd: '2026-09-12T00:00:00Z',
});

/** A quote sales put together: a named plan, a floor, and no single rate. */
const CONTRACTED = subscription({
  planName: 'Business',
  monthlyMinimumCents: 250_000,
  currentPeriodStart: '2026-08-12T00:00:00Z',
  currentPeriodEnd: '2026-09-12T00:00:00Z',
});

const TRIALING = subscription({
  planId: PlanId.FreeTrial,
  status: SubscriptionStatus.Trialing,
  trialEndsAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
});

const CARD = { id: 'pm_1', last4: '4242', brand: 'visa', expMonth: 7, expYear: 2031 };

const INVOICES: Invoice[] = [
  {
    id: 'in_3',
    amountDueInCents: 250_000,
    status: 'open',
    createdAt: '2026-08-01T00:00:00Z',
    invoicePdfUrl: 'https://example.com/in_3.pdf',
  },
  {
    id: 'in_2',
    amountDueInCents: 250_000,
    status: 'paid',
    createdAt: '2026-07-01T00:00:00Z',
    invoicePdfUrl: 'https://example.com/in_2.pdf',
  },
  {
    id: 'in_1',
    amountDueInCents: 187_450,
    status: 'paid',
    createdAt: '2026-06-01T00:00:00Z',
    invoicePdfUrl: null,
  },
];

const noop = () => {
  // Stories are for looking at, not clicking through.
};

function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex max-w-3xl flex-col gap-4">{children}</div>;
}

/**
 * The tab's own composition: the plan across the top, the two short cards paired
 * beneath it, and the invoice table across the bottom. This is what
 * `BillingDetails` lays out.
 */
export const TabLayout: StoryObj = {
  render: () => (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <PlanCard subscription={SELF_SERVE} mayManage onManage={noop} onChoosePlan={noop} />
        <PaymentMethodCard
          billing={{ subscription: SELF_SERVE, paymentMethod: CARD }}
          mayManage
          onManage={noop}
          onAddCard={noop}
        />
      </div>
      <UsageCard
        subscription={SELF_SERVE}
        storageBytesUsed={4.2 * TB_BYTES}
        egressBytesUsed={0.31 * TB_BYTES}
      />
      <InvoicesCard invoices={INVOICES} loading={false} onViewAll={noop} />
    </div>
  ),
};

/**
 * The tab with its help rail, heading included, which is how the page actually
 * lays out: the heading spans the row so the rail starts level with the cards
 * rather than with the heading.
 */
export const TabWithRail: StoryObj = {
  render: () => (
    <section className="flex flex-col gap-4">
      <Heading
        tag="h2"
        size="md"
        className="gap-0.5"
        description="Manage your plan, usage, and payment methods"
      >
        Billing
      </Heading>
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <div className="flex max-w-4xl min-w-0 flex-1 flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanCard subscription={SELF_SERVE} mayManage onManage={noop} onChoosePlan={noop} />
            <PaymentMethodCard
              billing={{ subscription: SELF_SERVE, paymentMethod: CARD }}
              mayManage
              onManage={noop}
              onAddCard={noop}
            />
          </div>
          <UsageCard
            subscription={SELF_SERVE}
            storageBytesUsed={4.2 * TB_BYTES}
            egressBytesUsed={0.31 * TB_BYTES}
          />
          <InvoicesCard invoices={INVOICES} loading={false} onViewAll={noop} />
        </div>
        <BillingHelpRail status={SubscriptionStatus.Active} onContactSales={noop} />
      </div>
    </section>
  ),
};

/** A trial, where the rail also offers the sales conversation. */
export const TabWithRailOnTrial: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
      <div className="flex max-w-4xl min-w-0 flex-1 flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <PlanCard subscription={TRIALING} mayManage onManage={noop} onChoosePlan={noop} />
          <PaymentMethodCard
            billing={{ subscription: TRIALING }}
            mayManage
            onManage={noop}
            onAddCard={noop}
          />
        </div>
        <UsageCard
          subscription={TRIALING}
          storageBytesUsed={0.62 * TB_BYTES}
          egressBytesUsed={0.11 * TB_BYTES}
        />
      </div>
      <BillingHelpRail status={SubscriptionStatus.Trialing} onContactSales={noop} />
    </div>
  ),
};

/** The whole tab, for the two customers who read it most differently. */
export const SelfServeAndContracted: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-10">
      <Stack>
        <PlanCard subscription={SELF_SERVE} mayManage onManage={noop} onChoosePlan={noop} />
        <UsageCard
          subscription={SELF_SERVE}
          storageBytesUsed={1.4 * TB_BYTES}
          egressBytesUsed={0.22 * TB_BYTES}
        />
        <PaymentMethodCard
          billing={{ subscription: SELF_SERVE, paymentMethod: CARD }}
          mayManage
          onManage={noop}
          onAddCard={noop}
        />
      </Stack>

      <Stack>
        <PlanCard subscription={CONTRACTED} mayManage onManage={noop} onChoosePlan={noop} />
        <UsageCard
          subscription={CONTRACTED}
          storageBytesUsed={412 * TB_BYTES}
          egressBytesUsed={38 * TB_BYTES}
        />
        <PaymentMethodCard
          billing={{ subscription: CONTRACTED }}
          mayManage
          onManage={noop}
          onAddCard={noop}
        />
      </Stack>
    </div>
  ),
};

export const Trialing: StoryObj = {
  render: () => (
    <Stack>
      <PlanCard subscription={TRIALING} mayManage onManage={noop} onChoosePlan={noop} />
      <UsageCard
        subscription={TRIALING}
        storageBytesUsed={0.62 * TB_BYTES}
        egressBytesUsed={0.11 * TB_BYTES}
      />
      <PaymentMethodCard
        billing={{ subscription: TRIALING }}
        mayManage
        onManage={noop}
        onAddCard={noop}
      />
    </Stack>
  ),
};

/** Every plan state the card has to name, in one place. */
export const PlanStates: StoryObj = {
  render: () => (
    <Stack>
      {[
        SELF_SERVE,
        CONTRACTED,
        TRIALING,
        { ...SELF_SERVE, status: SubscriptionStatus.PastDue },
        subscription({
          status: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        subscription({ status: SubscriptionStatus.Canceled, canceledAt: '2026-07-30T00:00:00Z' }),
        subscription({ planId: PlanId.None, status: SubscriptionStatus.Inactive }),
      ].map((plan) => (
        <PlanCard
          key={`${plan.status}-${plan.planName ?? 'unnamed'}`}
          subscription={plan}
          mayManage
          onManage={noop}
          onChoosePlan={noop}
        />
      ))}
    </Stack>
  ),
};

/** A caller with `billing.view` and not `billing.manage`: no action anywhere. */
export const ReadOnlyCaller: StoryObj = {
  render: () => (
    <Stack>
      <PlanCard subscription={SELF_SERVE} mayManage={false} onManage={noop} onChoosePlan={noop} />
      <PaymentMethodCard
        billing={{ subscription: SELF_SERVE, paymentMethod: CARD }}
        mayManage={false}
        onManage={noop}
        onAddCard={noop}
      />
    </Stack>
  ),
};

export const Invoices: StoryObj = {
  render: () => (
    <Stack>
      <InvoicesCard invoices={INVOICES} loading={false} onViewAll={noop} />
    </Stack>
  ),
};

/**
 * Every status the console can be handed, in the console's own words.
 *
 * `draft` is missing on purpose: `list-invoices` filters it out, because Stripe
 * has not finalised it and its amount can still change. `statusLabel` still
 * handles it, in case that ever changes.
 */
export const InvoiceStatuses: StoryObj = {
  render: () => (
    <Stack>
      <InvoicesCard
        loading={false}
        onViewAll={noop}
        invoices={[
          {
            id: 'in_open',
            amountDueInCents: 250_000,
            status: 'open',
            createdAt: '2026-08-01T00:00:00Z',
            invoicePdfUrl: 'https://example.com/in_open.pdf',
          },
          {
            id: 'in_paid',
            amountDueInCents: 250_000,
            status: 'paid',
            createdAt: '2026-07-01T00:00:00Z',
            invoicePdfUrl: 'https://example.com/in_paid.pdf',
          },
          {
            id: 'in_uncollectible',
            amountDueInCents: 187_450,
            status: 'uncollectible',
            createdAt: '2026-06-01T00:00:00Z',
            invoicePdfUrl: 'https://example.com/in_unc.pdf',
          },
          {
            id: 'in_void',
            amountDueInCents: 0,
            status: 'void',
            createdAt: '2026-05-01T00:00:00Z',
            invoicePdfUrl: null,
          },
          {
            id: 'in_unknown',
            amountDueInCents: 4999,
            status: 'unknown',
            createdAt: '2026-04-01T00:00:00Z',
            invoicePdfUrl: null,
          },
        ]}
      />
    </Stack>
  ),
};

export const InvoicesEmpty: StoryObj = {
  render: () => (
    <Stack>
      <InvoicesCard invoices={[]} loading={false} />
    </Stack>
  ),
};

export const InvoicesFailed: StoryObj = {
  render: () => (
    <Stack>
      <InvoicesCard
        loading={false}
        errorMessage="Unable to load invoices. Please try again later."
      />
    </Stack>
  ),
};

const BILLING_STATES: BillingInfo[] = [
  { subscription: SELF_SERVE, paymentMethod: CARD },
  { subscription: CONTRACTED },
  { subscription: TRIALING },
];

export const PaymentPostures: StoryObj = {
  render: () => (
    <Stack>
      {BILLING_STATES.map((billing) => (
        <PaymentMethodCard
          key={billing.subscription.status + (billing.paymentMethod ? '-card' : '')}
          billing={billing}
          mayManage
          onManage={noop}
          onAddCard={noop}
        />
      ))}
    </Stack>
  ),
};
