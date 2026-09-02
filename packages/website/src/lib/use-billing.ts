// The Billing tab's data and its flows, kept out of the component that renders
// them.
//
// Not a refactor for its own sake: `BillingDetails` carried three queries, five
// dialog handlers, and the Stripe round trips inline, and paid for it with an
// `eslint-disable` for cognitive complexity that had been standing long enough
// to stop meaning anything. Two hooks and a page that reads top to bottom is
// the alternative to the suppression.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SubscriptionStatus } from '@filone/shared';
import type { BillingInfo, CreateSetupIntentResponse, UsageResponse } from '@filone/shared';

import { useToast } from '../components/Toast';
import { activateSubscription, apiRequest, getBilling, getInvoices, getUsage } from './api.js';
import { queryKeys, USAGE_STALE_TIME } from './query-client.js';
import { usePermittedDialog } from './use-permitted-dialog.js';

/** Neither a trial nor an unentitled account has invoices to fetch. */
export function hasInvoiceHistory(status: SubscriptionStatus): boolean {
  return status !== SubscriptionStatus.Trialing && status !== SubscriptionStatus.Inactive;
}

/** The two states a saved card can be put straight back to work from. */
function isReactivatable(status: SubscriptionStatus | undefined): boolean {
  return status === SubscriptionStatus.GracePeriod || status === SubscriptionStatus.Canceled;
}

export interface BillingData {
  billing?: BillingInfo;
  usage?: UsageResponse;
  invoices?: BillingInvoices;
  /** Nothing to render yet, as opposed to a refetch behind rows already up. */
  loading: boolean;
  /** Why billing could not be read, when it could not be. */
  error: string | null;
  invoicesPending: boolean;
  invoicesFailed: boolean;
}

type BillingInvoices = Awaited<ReturnType<typeof getInvoices>>;

/**
 * What the tab reads. Invoices wait for billing, since whether to ask for them
 * at all depends on the plan's state.
 */
export function useBillingData(): BillingData {
  const {
    data: billing,
    isPending: billingPending,
    isError: isBillingError,
    error: billingError,
  } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });

  const { data: usage, isPending: usagePending } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
    staleTime: USAGE_STALE_TIME,
  });

  const {
    data: invoices,
    isPending: invoicesPending,
    isError: isInvoicesError,
  } = useQuery({
    queryKey: queryKeys.invoices,
    queryFn: getInvoices,
    enabled: !!billing && hasInvoiceHistory(billing.subscription.status),
  });

  return {
    billing,
    usage,
    invoices,
    loading: billingPending || usagePending,
    error: isBillingError ? (billingError?.message ?? 'Failed to load billing information') : null,
    invoicesPending,
    invoicesFailed: isInvoicesError,
  };
}

export interface BillingFlows {
  planOpen: boolean;
  paymentOpen: boolean;
  contactSalesOpen: boolean;
  clientSecret: string;
  stripePublishableKey: string;
  /** True when a saved card can be put back to work without a new SetupIntent. */
  canReactivateWithSavedCard: boolean;
  openPlan: () => void;
  closePlan: () => void;
  closePayment: () => void;
  openContactSales: () => void;
  closeContactSales: () => void;
  /** Leaves the plan dialog for the sales conversation. */
  contactSalesFromPlan: () => void;
  /** Back from the card form to the plan choice behind it. */
  backToPlan: () => void;
  /** Puts a different card on file instead of reusing the saved one. */
  useDifferentCard: () => void;
  selectPayAsYouGo: () => Promise<void>;
  paymentSucceeded: () => void;
  refreshSetupIntent: () => Promise<string>;
  /**
   * Opens Stripe's customer portal. Everything about the subscription itself
   * lives there — the plan, the card, the cancellation, the tax details — so
   * the console hands the customer the authoritative place rather than
   * mirroring its forms.
   */
  openStripePortal: () => Promise<void>;
}

/**
 * Which dialog is open, and the moves between them.
 *
 * Both dialogs that write billing close on their own if the caller loses
 * `billing.manage` mid-flow: the payment one is the sharp edge, since confirming
 * it hands Stripe a SetupIntent that `activateSubscription` would then refuse.
 */
function useBillingDialogs(mayManage: boolean) {
  const [planOpen, setPlanOpen] = usePermittedDialog(false, mayManage);
  const [paymentOpen, setPaymentOpen] = usePermittedDialog(false, mayManage);
  const [contactSalesOpen, setContactSalesOpen] = useState(false);

  return {
    planOpen,
    paymentOpen,
    contactSalesOpen,
    setPlanOpen,
    setPaymentOpen,
    openPlan: () => setPlanOpen(true),
    closePlan: () => setPlanOpen(false),
    closePayment: () => setPaymentOpen(false),
    openContactSales: () => setContactSalesOpen(true),
    closeContactSales: () => setContactSalesOpen(false),
    contactSalesFromPlan: () => {
      setPlanOpen(false);
      setContactSalesOpen(true);
    },
    backToPlan: () => {
      setPaymentOpen(false);
      setPlanOpen(true);
    },
  };
}

/**
 * The trips to Stripe: a SetupIntent for a new card, an activation for a saved
 * one, and the customer portal for everything else.
 */
export function useBillingFlows(
  billing: BillingInfo | undefined,
  mayManage: boolean,
): BillingFlows {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dialogs = useBillingDialogs(mayManage);
  const [clientSecret, setClientSecret] = useState('');
  const [stripePublishableKey, setStripePublishableKey] = useState('');

  // Coming back from the portal, where the plan or the card may have changed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('portal_return') !== 'true') return;
    // Only Stripe's own parameter comes off. It used to replace the URL with
    // the bare pathname, which also dropped the `tab=billing` that put the
    // caller on this tab — so a portal return bounced them back to Members.
    params.delete('portal_return');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.billing });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
  }, [queryClient]);

  const canReactivateWithSavedCard =
    Boolean(billing?.paymentMethod?.id) && isReactivatable(billing?.subscription.status);

  function refreshBilling() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.billing });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    window.dispatchEvent(new CustomEvent('billing:updated'));
  }

  async function startNewCardFlow() {
    try {
      const { clientSecret: cs, stripePublishableKey: pk } =
        await apiRequest<CreateSetupIntentResponse>('/billing/setup-intent', { method: 'POST' });
      setClientSecret(cs);
      setStripePublishableKey(pk);
      dialogs.setPaymentOpen(true);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to set up payment. Please try again.');
    }
  }

  async function selectPayAsYouGo() {
    dialogs.setPlanOpen(false);
    if (!canReactivateWithSavedCard) {
      await startNewCardFlow();
      return;
    }
    try {
      await activateSubscription({ useSavedPaymentMethod: true });
      toast.success('Subscription reactivated!');
      refreshBilling();
    } catch (err) {
      toast.error((err as Error).message || 'Failed to reactivate. Please try again.');
    }
  }

  async function openStripePortal() {
    try {
      const { url } = await apiRequest<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (err) {
      toast.error((err as Error).message || 'Failed to open billing portal.');
    }
  }

  async function refreshSetupIntent(): Promise<string> {
    const { clientSecret: cs } = await apiRequest<CreateSetupIntentResponse>(
      '/billing/setup-intent',
      { method: 'POST' },
    );
    return cs;
  }

  function paymentSucceeded() {
    dialogs.setPaymentOpen(false);
    setClientSecret('');
    toast.success('Subscription activated!');
    refreshBilling();
  }

  function useDifferentCard() {
    dialogs.setPlanOpen(false);
    void startNewCardFlow();
  }

  return {
    ...dialogs,
    clientSecret,
    stripePublishableKey,
    canReactivateWithSavedCard,
    useDifferentCard,
    selectPayAsYouGo,
    paymentSucceeded,
    refreshSetupIntent,
    openStripePortal,
  };
}
