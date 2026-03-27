import { useCallback, useEffect, useState } from 'react';

import {
  CheckIcon,
  CreditCardIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  WarningIcon,
  DownloadSimpleIcon,
  LightningIcon,
  ShieldCheckIcon,
  LockSimpleIcon,
} from '@phosphor-icons/react/dist/ssr';

import { ProgressBar } from '../components/ProgressBar';
import { useToast } from '../components/Toast';
import { formatBytes } from '@filone/shared';

import { SubscriptionStatus, TB_BYTES, getUsageLimits } from '@filone/shared';
import type {
  BillingInfo,
  UsageResponse,
  CreateSetupIntentResponse,
  ListInvoicesResponse,
} from '@filone/shared';

import { apiRequest, getUsage, getInvoices } from '../lib/api.js';
import { daysUntil, formatDate } from '../lib/time.js';
import { ChoosePlanDialog } from '../components/billing/ChoosePlanDialog.js';
import { AddPaymentDialog } from '../components/billing/AddPaymentDialog.js';
import { ContactSalesDialog } from '../components/billing/ContactSalesDialog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Skeleton loaders
// ---------------------------------------------------------------------------

function SkeletonCard({ height = 'h-36' }: { height?: string }) {
  return (
    <div className={`animate-pulse rounded-xl border border-[#e1e4ea] bg-white p-6 ${height}`}>
      <div className="h-3 w-24 rounded bg-zinc-200 mb-4" />
      <div className="h-4 w-48 rounded bg-zinc-200 mb-2" />
      <div className="h-3 w-36 rounded bg-zinc-200" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BillingPage() {
  const { toast } = useToast();

  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<ListInvoicesResponse | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);

  // Modal states
  const [planOpen, setPlanOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [clientSecret, setClientSecret] = useState('');
  const [contactSalesOpen, setContactSalesOpen] = useState(false);

  const fetchBilling = useCallback(async () => {
    try {
      setLoading(true);
      const [billingData, usageData] = await Promise.all([
        apiRequest<BillingInfo>('/billing'),
        getUsage(),
      ]);
      setBilling(billingData);
      setUsage(usageData);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBilling();
  }, [fetchBilling]);

  // Handle portal return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('portal_return') === 'true') {
      // Clear the URL param and refresh billing data
      window.history.replaceState({}, '', window.location.pathname);
      void fetchBilling();
    }
  }, [fetchBilling]);

  // Fetch invoices once billing loads (skip for trial users)
  useEffect(() => {
    if (!billing || billing.subscription.status === SubscriptionStatus.Trialing) return;
    setInvoicesLoading(true);
    getInvoices()
      .then((data) => {
        setInvoices(data);
        setInvoicesError(null);
      })
      .catch(() => {
        setInvoicesError('Unable to load invoices. Please try again later.');
      })
      .finally(() => setInvoicesLoading(false));
  }, [billing]);

  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const isActive = billing?.subscription.status === SubscriptionStatus.Active;
  const isPastDue = billing?.subscription.status === SubscriptionStatus.PastDue;
  const isGracePeriod = billing?.subscription.status === SubscriptionStatus.GracePeriod;
  const isCanceled = billing?.subscription.status === SubscriptionStatus.Canceled;
  const trialDays =
    isTrialing && billing?.subscription.trialEndsAt
      ? daysUntil(billing.subscription.trialEndsAt)
      : null;
  const graceDays = billing?.subscription.gracePeriodEndsAt
    ? daysUntil(billing.subscription.gracePeriodEndsAt)
    : null;
  const isTrialExpiredGrace = isGracePeriod && !!billing?.subscription.trialEndsAt;

  const limits = getUsageLimits(!!isActive);
  const storageUsed = usage?.storage.usedBytes ?? 0;
  const storageLimit = limits.storageLimitBytes;
  const storagePct = storageLimit > 0 ? Math.min(100, (storageUsed / storageLimit) * 100) : 0;
  const egressUsed = usage?.egress.usedBytes ?? 0;
  const egressLimit = limits.egressLimitBytes;
  const egressPct = egressLimit > 0 ? Math.min(100, (egressUsed / egressLimit) * 100) : 0;
  const PRICE_PER_TB_CENTS = 499;
  const estimatedCost = Math.round((storageUsed / TB_BYTES) * PRICE_PER_TB_CENTS);

  // ── Handlers ─────────────────────────────────────────────────────

  function handleUpgradeClick() {
    setPlanOpen(true);
  }

  function handleContactSales() {
    setPlanOpen(false);
    setContactSalesOpen(true);
  }

  async function handleSelectPayAsYouGo() {
    setPlanOpen(false);
    try {
      const { clientSecret: cs } = await apiRequest<CreateSetupIntentResponse>(
        '/billing/setup-intent',
        { method: 'POST' },
      );
      setClientSecret(cs);
      setPaymentOpen(true);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to set up payment. Please try again.');
    }
  }

  function handlePaymentBack() {
    setPaymentOpen(false);
    setPlanOpen(true);
  }

  function handlePaymentSuccess() {
    setPaymentOpen(false);
    setClientSecret('');
    toast.success('Subscription activated!');
    void fetchBilling();
    window.dispatchEvent(new CustomEvent('billing:updated'));
  }

  async function handleUpdatePayment() {
    try {
      const { url } = await apiRequest<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (err) {
      toast.error((err as Error).message || 'Failed to open billing portal.');
    }
  }

  // ── Loading state ────────────────────────────────────────────────

  if (loading && !billing) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-[#14181f] mb-1">Billing</h1>
        <p className="text-sm text-[#677183] mb-6">Manage your plan, usage, and payment methods</p>
        <div className="flex gap-6">
          <div className="flex-1 flex flex-col gap-4">
            <SkeletonCard height="h-40" />
            <SkeletonCard height="h-32" />
            <SkeletonCard height="h-28" />
          </div>
          <div className="w-[368px] flex-shrink-0">
            <SkeletonCard height="h-80" />
          </div>
        </div>
      </div>
    );
  }

  if (error && !billing) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-[#14181f] mb-1">Billing</h1>
        <p className="text-sm text-[#677183] mb-6">Manage your plan, usage, and payment methods</p>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Failed to load billing information: {error}
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-[#14181f] mb-1">Billing</h1>
      <p className="text-sm text-[#677183] mb-6">Manage your plan, usage, and payment methods</p>

      {/* Past due warning banner */}
      {isPastDue && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <WarningIcon size={20} className="text-amber-600 flex-shrink-0" weight="fill" />
          <span className="text-sm text-amber-800">
            Your last payment failed. Please{' '}
            <button type="button" onClick={handleUpdatePayment} className="font-semibold underline">
              update your payment method
            </button>{' '}
            to avoid losing access.{graceDays !== null ? ` ${graceDays} days remaining.` : ''}
          </span>
        </div>
      )}

      {/* Grace period warning banner */}
      {isGracePeriod && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <WarningIcon size={20} className="text-amber-600 flex-shrink-0" weight="fill" />
          <span className="text-sm text-amber-800">
            {isTrialExpiredGrace
              ? `Your free trial has expired.${graceDays !== null ? ` ${graceDays} days remaining` : ''} to upgrade or download your data.`
              : `Subscription canceled.${graceDays !== null ? ` ${graceDays} days remaining` : ''} to reactivate or download your data.`}{' '}
            <button type="button" onClick={handleUpgradeClick} className="font-semibold underline">
              {isTrialExpiredGrace ? 'Upgrade now' : 'Reactivate'}
            </button>
          </span>
        </div>
      )}

      {/* Canceled banner */}
      {isCanceled && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <WarningIcon size={20} className="text-red-600 flex-shrink-0" weight="fill" />
          <span className="text-sm text-red-800">
            Your account has been canceled.{' '}
            <button type="button" onClick={handleUpgradeClick} className="font-semibold underline">
              Reactivate
            </button>{' '}
            to regain access.
          </span>
        </div>
      )}

      <div className="flex gap-6">
        {/* ── Left column ──────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col gap-6">
          {/* Plan card */}
          <div className="rounded-lg border border-[rgba(0,128,255,0.2)] bg-white flex flex-col gap-4 py-4 px-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[13px] font-medium tracking-[-0.325px] leading-[19.5px] text-[#14181f]">
                  {isActive || isPastDue || isGracePeriod || isCanceled
                    ? 'Pay-as-you-go'
                    : 'Free Trial'}
                </h2>
                <p className="text-[13px] text-[#677183] leading-[19.5px]">
                  {isActive || isPastDue
                    ? 'Unlimited storage, pay only for what you use'
                    : isGracePeriod
                      ? `Read-only access${graceDays !== null ? ` — ${graceDays} days remaining` : ''}`
                      : isCanceled
                        ? 'Subscription inactive'
                        : trialDays !== null
                          ? `${trialDays} days remaining \u00b7 1 TB included`
                          : '30-day trial \u00b7 1 TB included'}
                </p>
              </div>

              {/* Status badge */}
              <div className="flex items-center gap-2">
                {isTrialing && (
                  <span className="flex items-center gap-1 rounded-[6px] bg-[rgba(0,128,255,0.1)] px-2 py-0.5 text-[12px] font-medium leading-[16px] text-[#0080FF]">
                    <CheckIcon size={12} weight="fill" />
                    Active
                  </span>
                )}
                {(isActive || isPastDue) && (
                  <span className="flex items-center gap-1 rounded-[6px] bg-[rgba(16,183,127,0.1)] px-2 py-0.5 text-[12px] font-medium leading-[16px] text-[#059669]">
                    <CheckIcon size={12} weight="fill" />
                    Active
                  </span>
                )}
                {isGracePeriod && (
                  <span className="rounded-[6px] bg-amber-100 px-2 py-0.5 text-[12px] font-medium leading-[16px] text-amber-700">
                    Grace Period
                  </span>
                )}
                {isCanceled && (
                  <span className="rounded-[6px] bg-red-100 px-2 py-0.5 text-[12px] font-medium leading-[16px] text-red-700">
                    Canceled
                  </span>
                )}
              </div>
            </div>

            {/* Trial CTA banner */}
            {isTrialing && (
              <div className="rounded-lg bg-[rgba(243,244,246,0.5)] border border-[rgba(225,228,234,0.5)] p-[13px] flex items-center justify-between">
                <p className="text-[13px] font-medium text-[#14181f]">
                  Ready to unlock unlimited storage?
                </p>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1.5 rounded-[6px] h-8 px-4 py-2 text-[12px] font-medium leading-[18px] text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90"
                  style={{ backgroundImage: 'linear-gradient(135deg, #0080FF 0%, #256AF4 100%)' }}
                >
                  Upgrade
                  <ArrowUpRightIcon size={16} weight="bold" />
                </button>
              </div>
            )}

            {/* Grace period / Canceled reactivation CTA */}
            {(isGracePeriod || isCanceled) && (
              <div
                className={`rounded-lg p-[13px] flex items-center justify-between ${
                  isCanceled
                    ? 'bg-red-50 border border-red-200'
                    : 'bg-amber-50 border border-amber-200'
                }`}
              >
                <p className="text-[13px] font-medium text-[#14181f]">
                  {isCanceled
                    ? 'Reactivate your subscription to regain full access'
                    : isTrialExpiredGrace
                      ? 'Upgrade to keep your data and unlock unlimited storage'
                      : 'Reactivate your subscription to restore full access'}
                </p>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1.5 rounded-[6px] h-8 px-4 py-2 text-[12px] font-medium leading-[18px] text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90"
                  style={{ backgroundImage: 'linear-gradient(135deg, #0080FF 0%, #256AF4 100%)' }}
                >
                  {isTrialExpiredGrace ? 'Upgrade' : 'Reactivate'}
                  <ArrowRightIcon size={16} weight="bold" />
                </button>
              </div>
            )}
          </div>

          {/* Current usage card */}
          <div className="rounded-lg border border-[#e1e4ea] bg-white flex flex-col gap-5 p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
            <div>
              <h3 className="text-[13px] font-medium tracking-[-0.325px] leading-[19.5px] text-[#14181f]">
                Current usage
              </h3>
              <p className="text-[13px] text-[#677183] leading-[19.5px] mt-1">
                {isTrialing
                  ? 'Storage and egress during your free trial'
                  : isActive || isPastDue || isGracePeriod
                    ? 'Your usage this billing period'
                    : isCanceled
                      ? 'Usage at time of cancellation'
                      : 'Storage and egress during your free trial'}
              </p>
            </div>

            <div className="flex flex-col gap-4 w-full">
              {/* Storage bar */}
              <div className="flex flex-col gap-[10px] w-full">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#677183]">Storage used</span>
                  <span className="text-[13px] font-medium text-[#14181f]">
                    {formatBytes(storageUsed)}
                    {storageLimit > 0 && ` / ${formatBytes(storageLimit)}`}
                  </span>
                </div>
                <ProgressBar value={storagePct} size="md" label="Storage usage" />
              </div>

              {/* Egress bar (trial only) */}
              {isTrialing && (
                <div className="flex flex-col gap-[10px] w-full">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-[#677183]">Egress used</span>
                    <span className="text-[13px] font-medium text-[#14181f]">
                      {formatBytes(egressUsed)}
                      {egressLimit > 0 && ` / ${formatBytes(egressLimit)}`}
                    </span>
                  </div>
                  <ProgressBar value={egressPct} size="md" label="Egress usage" />
                  <p className="text-xs text-[#677183]">
                    No egress fees after upgrading to pay-as-you-go
                  </p>
                </div>
              )}

              {/* Estimated cost (active/grace) */}
              {(isActive || isPastDue || isGracePeriod) && (
                <div className="w-full rounded-lg bg-[rgba(243,244,246,0.5)] p-3 flex items-center justify-between">
                  <span className="text-[13px] font-normal text-[#677183]">
                    Estimated monthly cost
                  </span>
                  <span className="text-[18px] font-semibold leading-[28px] text-[#14181f]">
                    {formatCents(estimatedCost)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Payment method card */}
          <div className="rounded-lg border border-[#e1e4ea] bg-white flex flex-col gap-5 p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
            <div>
              <h3 className="text-[13px] font-medium tracking-[-0.325px] leading-[19.5px] text-[#14181f]">
                Payment method
              </h3>
              <p className="text-[13px] text-[#677183] leading-[19.5px] mt-1">
                {billing?.paymentMethod
                  ? 'Your active payment method'
                  : 'Add a payment method to continue after your trial'}
              </p>
            </div>

            {billing?.paymentMethod ? (
              <div className="w-full rounded-lg border border-[#e1e4ea] p-[13px] flex items-center gap-3">
                <div className="flex h-7 w-10 items-center justify-center rounded bg-gradient-to-r from-[rgba(0,128,255,0.8)] to-[#0080ff] flex-shrink-0">
                  <CreditCardIcon size={16} className="text-white" weight="fill" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium leading-[19.5px] text-[#14181f]">
                    &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull;{' '}
                    {billing.paymentMethod.last4}
                  </p>
                  <p className="text-xs text-[#677183] leading-[18px]">
                    Expires {String(billing.paymentMethod.expMonth).padStart(2, '0')}/
                    {String(billing.paymentMethod.expYear).slice(-2)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleUpdatePayment}
                  className="h-7 rounded-md bg-[#f9fafb] border border-[#e1e4ea] px-[13px] text-xs font-medium text-[#14181f] shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] transition-colors hover:bg-zinc-100 flex-shrink-0"
                >
                  Update
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-[rgba(225,228,234,0.8)] bg-[rgba(243,244,246,0.3)] p-[13px] w-full">
                <div className="flex h-7 w-10 items-center justify-center rounded bg-[#f3f4f6] flex-shrink-0">
                  <CreditCardIcon size={16} className="text-[#677183]" />
                </div>
                <span className="flex-1 text-[13px] text-[#677183]">No payment method added</span>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1 h-7 rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-[13px] text-[12px] font-medium text-[#14181f] shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] transition-colors hover:bg-zinc-100"
                >
                  <CreditCardIcon size={16} />
                  Add
                </button>
              </div>
            )}
          </div>

          {/* Invoice history card */}
          {!isTrialing && invoicesLoading && (
            <div className="animate-pulse rounded-xl border border-[#e1e4ea] bg-white p-6">
              <div className="h-3 w-28 rounded bg-zinc-200 mb-2" />
              <div className="h-3 w-44 rounded bg-zinc-200 mb-4" />
              <div className="h-4 w-full rounded bg-zinc-200 mb-3" />
              <div className="h-4 w-full rounded bg-zinc-200 mb-3" />
              <div className="h-4 w-full rounded bg-zinc-200" />
            </div>
          )}
          {!isTrialing && !invoicesLoading && (
            <div className="rounded-xl border border-[#e1e4ea] bg-white p-6">
              <h3 className="text-[13px] font-semibold text-[#14181f] mb-0.5">Invoice history</h3>
              <p className="text-[13px] text-[#99a0ae] mb-4">Recent billing statements</p>

              {invoicesError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <WarningIcon size={16} className="text-red-600 flex-shrink-0" weight="fill" />
                  <span className="text-sm text-red-700">{invoicesError}</span>
                </div>
              )}

              {!invoicesError && invoices && invoices.invoices.length === 0 && (
                <p className="text-sm text-[#99a0ae]">
                  No invoices yet. Your invoices will appear here after your first billing cycle.
                </p>
              )}

              {!invoicesError && invoices && invoices.invoices.length > 0 && (
                <div>
                  {invoices.invoices.map((inv, idx) => (
                    <div
                      key={inv.id}
                      className={`flex items-center justify-between py-3 ${
                        idx > 0 ? 'border-t border-[#e1e4ea]' : ''
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="text-[13px] font-medium text-[#14181f]">
                          {formatDate(inv.createdAt)}
                        </span>
                        <span className="text-[11px] text-[#99a0ae] capitalize">{inv.status}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-[14px] font-semibold text-[#14181f]">
                          {formatCents(inv.amountDueInCents)}
                        </span>
                        {inv.invoicePdfUrl && (
                          <a
                            href={inv.invoicePdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-[13px] font-medium text-[#0066ff] hover:underline"
                          >
                            <DownloadSimpleIcon
                              size={14}
                              className="text-[#677183]"
                              aria-hidden="true"
                            />
                            PDF
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right column (pricing sidebar) ─────────────────── */}
        <div className="w-[368px] flex-shrink-0">
          <div className="rounded-lg border border-[#e1e4ea] bg-white shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] overflow-hidden p-px">
            {/* Header */}
            <div
              className="flex flex-col gap-[6px] px-4 pt-4 pb-[13px] border-b border-[rgba(225,228,234,0.5)]"
              style={{
                backgroundImage:
                  'linear-gradient(166.48deg, rgba(0,128,255,0.05) 0%, rgba(0,128,255,0.1) 50%, rgba(0,128,255,0.05) 100%)',
              }}
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.55px] leading-[16.5px] text-[#677183]">
                Pay-as-you-go
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold leading-9 text-[#14181f]">$4.99</span>
                <span className="text-[12px] leading-[18px] text-[#677183]">/ TB / month</span>
              </div>
            </div>

            {/* Features */}
            <div className="flex flex-col gap-4 p-4">
              <ul className="flex flex-col gap-[10px]">
                <li className="flex items-center gap-[10px] text-[13px] text-[#677183]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f3f4f6] flex-shrink-0">
                    <CheckIcon size={12} className="text-[#3a4252]" weight="bold" />
                  </span>
                  Pay only for what you use
                </li>
                <li className="flex items-center gap-[10px] text-[13px] text-[#14181f]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(16,183,127,0.1)] flex-shrink-0">
                    <LightningIcon size={12} className="text-[#10b77f]" weight="fill" />
                  </span>
                  <strong className="font-medium">No egress fees</strong>
                </li>
                <li className="flex items-center gap-[10px] text-[13px] text-[#14181f]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(16,183,127,0.1)] flex-shrink-0">
                    <LightningIcon size={12} className="text-[#10b77f]" weight="fill" />
                  </span>
                  <strong className="font-medium">No API request fees</strong>
                </li>
                <li className="flex items-center gap-[10px] text-[13px] text-[#677183]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f3f4f6] flex-shrink-0">
                    <ShieldCheckIcon size={12} className="text-[#3a4252]" weight="fill" />
                  </span>
                  Data integrity guarantees
                </li>
                <li className="flex items-center gap-[10px] text-[13px] text-[#677183]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f3f4f6] flex-shrink-0">
                    <LockSimpleIcon size={12} className="text-[#3a4252]" weight="fill" />
                  </span>
                  Enterprise-grade security
                </li>
              </ul>

              {/* CTA for trial / grace / canceled users */}
              {(isTrialing || isGracePeriod || isCanceled) && (
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex w-full items-center justify-center gap-2 rounded-[6px] h-[36px] px-4 py-2 text-[13px] font-medium text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90"
                  style={{ backgroundImage: 'linear-gradient(135deg, #0080FF 0%, #256AF4 100%)' }}
                >
                  <LightningIcon size={16} weight="fill" />
                  {isTrialing ? 'Upgrade now' : 'Reactivate'}
                </button>
              )}
            </div>
          </div>

          {/* Need more? section */}
          <div className="flex flex-col gap-1 mt-5 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.55px] leading-[16.5px] text-[#677183]">
              Need more?
            </p>
            <p className="text-[12px] leading-[19.5px] text-[#677183]">
              The <strong className="font-medium text-[#14181f]">Business plan</strong> offers
              volume discounts, SLA guarantees, and dedicated support.
            </p>
            <button
              type="button"
              onClick={() => setContactSalesOpen(true)}
              className="text-[12px] font-medium leading-[18px] text-[#0080ff] hover:underline text-left"
            >
              Contact sales &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* Modals */}
      <ChoosePlanDialog
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        onSelectPayAsYouGo={handleSelectPayAsYouGo}
        onContactSales={handleContactSales}
      />

      <AddPaymentDialog
        open={paymentOpen}
        clientSecret={clientSecret}
        onClose={() => setPaymentOpen(false)}
        onBack={handlePaymentBack}
        onSuccess={handlePaymentSuccess}
      />

      <ContactSalesDialog open={contactSalesOpen} onClose={() => setContactSalesOpen(false)} />
    </div>
  );
}
