import { useCallback, useEffect, useState } from 'react';

import {
  CheckCircleIcon,
  CheckIcon,
  CreditCardIcon,
  ArrowRightIcon,
  WarningIcon,
  CloudIcon,
  DownloadSimpleIcon,
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
        <h1 className="text-2xl font-semibold text-[#14181f] mb-6">Billing</h1>
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
        <h1 className="text-2xl font-semibold text-[#14181f] mb-6">Billing</h1>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Failed to load billing information: {error}
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-[#14181f] mb-6">Billing</h1>

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
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {/* Plan card */}
          <div
            className={`rounded-xl border-2 p-6 bg-white ${
              isActive || isPastDue
                ? 'border-[rgba(16,183,127,0.2)]'
                : isCanceled
                  ? 'border-red-200'
                  : isGracePeriod
                    ? 'border-amber-200'
                    : 'border-[rgba(0,128,255,0.2)]'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {/* Icon */}
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                    isActive || isPastDue
                      ? 'bg-[rgba(16,183,127,0.1)]'
                      : isGracePeriod
                        ? 'bg-amber-100'
                        : isCanceled
                          ? 'bg-red-100'
                          : 'bg-gradient-to-br from-[#0066ff] to-[#0052cc]'
                  }`}
                >
                  <CloudIcon
                    size={20}
                    weight="fill"
                    className={
                      isActive || isPastDue
                        ? 'text-[#10b77f]'
                        : isGracePeriod
                          ? 'text-amber-600'
                          : isCanceled
                            ? 'text-red-600'
                            : 'text-white'
                    }
                  />
                </div>

                <div>
                  <h2 className="text-lg font-semibold text-[#14181f]">
                    {isActive || isPastDue || isGracePeriod || isCanceled
                      ? 'Pay-as-you-go'
                      : 'Free Trial'}
                  </h2>
                  <p className="text-sm text-[#677183]">
                    {isActive || isPastDue
                      ? 'Unlimited storage, pay only for what you use'
                      : isGracePeriod
                        ? `Read-only access${graceDays !== null ? ` — ${graceDays} days remaining` : ''}`
                        : isCanceled
                          ? 'Subscription inactive'
                          : trialDays !== null
                            ? `${trialDays} days remaining — 1 TB included`
                            : '14-day trial — 1 TB included'}
                  </p>
                </div>
              </div>

              {/* Status badge */}
              {isTrialing && (
                <span className="rounded-full bg-[#dbeafe] px-3 py-1 text-xs font-semibold text-[#1e40af]">
                  Trial
                </span>
              )}
              {(isActive || isPastDue) && (
                <span className="flex items-center gap-1 rounded-full bg-[rgba(16,183,127,0.1)] px-3 py-1 text-xs font-semibold text-[#059669]">
                  <CheckCircleIcon size={14} weight="fill" />
                  Active
                </span>
              )}
              {isGracePeriod && (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                  Grace Period
                </span>
              )}
              {isCanceled && (
                <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
                  Canceled
                </span>
              )}
            </div>

            {/* Trial CTA banner */}
            {isTrialing && (
              <div className="mt-4 rounded-lg bg-[#f8fafc] border border-[#e1e4ea] px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-[#14181f]">
                    Ready to unlock unlimited storage?
                  </p>
                  <p className="text-xs text-[#99a0ae] mt-0.5">
                    No credit card required during trial
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Upgrade
                  <ArrowRightIcon size={14} weight="bold" />
                </button>
              </div>
            )}

            {/* Grace period / Canceled reactivation CTA */}
            {(isGracePeriod || isCanceled) && (
              <div
                className={`mt-4 rounded-lg px-4 py-3 flex items-center justify-between ${
                  isCanceled
                    ? 'bg-red-50 border border-red-200'
                    : 'bg-amber-50 border border-amber-200'
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-[#14181f]">
                    {isCanceled
                      ? 'Reactivate your subscription to regain full access'
                      : isTrialExpiredGrace
                        ? 'Upgrade to keep your data and unlock unlimited storage'
                        : 'Reactivate your subscription to restore full access'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  {isTrialExpiredGrace ? 'Upgrade' : 'Reactivate'}
                  <ArrowRightIcon size={14} weight="bold" />
                </button>
              </div>
            )}
          </div>

          {/* Current usage card */}
          <div className="rounded-xl border border-[#e1e4ea] bg-white p-6">
            <h3 className="text-sm font-semibold text-[#14181f] mb-1">Current usage</h3>
            <p className="text-xs text-[#99a0ae] mb-4">
              {isActive || isPastDue || isGracePeriod
                ? 'Your usage this billing period'
                : isCanceled
                  ? 'Usage at time of cancellation'
                  : 'Trial usage (1 TB limit)'}
            </p>

            {/* Storage bar */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-[#3a4252]">Storage used</span>
              <span className="text-sm font-medium text-[#14181f]">
                {formatBytes(storageUsed)}
                {storageLimit > 0 && ` / ${formatBytes(storageLimit)}`}
              </span>
            </div>
            <ProgressBar value={storagePct} size="sm" label="Storage usage" />

            {/* Estimated cost (active/grace) */}
            {(isActive || isPastDue || isGracePeriod) && (
              <div className="mt-4 flex items-center justify-between pt-4 border-t border-[#f1f2f4]">
                <span className="text-sm text-[#3a4252]">Estimated monthly cost</span>
                <span className="text-sm font-semibold text-[#14181f]">
                  {formatCents(estimatedCost)}
                </span>
              </div>
            )}
          </div>

          {/* Payment method card */}
          <div className="rounded-xl border border-[#e1e4ea] bg-white p-6">
            <h3 className="text-sm font-semibold text-[#14181f] mb-4">Payment method</h3>

            {billing?.paymentMethod ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[#0066ff] to-[#0052cc]">
                    <CreditCardIcon size={20} className="text-white" weight="fill" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[#14181f]">
                      &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull;{' '}
                      {billing.paymentMethod.last4}
                    </p>
                    <p className="text-xs text-[#99a0ae]">
                      Expires {String(billing.paymentMethod.expMonth).padStart(2, '0')}/
                      {String(billing.paymentMethod.expYear).slice(-2)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleUpdatePayment}
                  className="rounded-lg border border-[#e1e4ea] px-3 py-1.5 text-sm font-medium text-[#3a4252] transition-colors hover:bg-zinc-50"
                >
                  Update
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-[#e1e4ea] px-6 py-8">
                <CreditCardIcon size={32} className="text-[#c9cdd6]" />
                <p className="text-sm text-[#99a0ae]">No payment method added</p>
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="rounded-lg border border-[#e1e4ea] px-3 py-1.5 text-sm font-medium text-[#3a4252] transition-colors hover:bg-zinc-50"
                >
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
          <div className="rounded-xl border border-[#e1e4ea] bg-white overflow-hidden">
            {/* Blue header */}
            <div className="bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-6 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">
                {isActive || isPastDue || isGracePeriod ? 'Simple pricing' : 'Pay-as-you-go'}
              </p>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white">$4.99</span>
                <span className="text-sm text-white/70">/ TB / month</span>
              </div>
            </div>

            {/* Features */}
            <div className="px-6 py-5">
              <ul className="flex flex-col gap-3">
                {[
                  'No egress fees',
                  'No API request fees',
                  'Data integrity guarantees',
                  'Enterprise-grade security',
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm text-[#3a4252]">
                    <CheckIcon size={16} className="text-[#10b77f] flex-shrink-0" weight="bold" />
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA for trial / grace / canceled users */}
              {(isTrialing || isGracePeriod || isCanceled) && (
                <button
                  type="button"
                  onClick={handleUpgradeClick}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  {isTrialing ? 'Upgrade now' : 'Reactivate'}
                </button>
              )}

              {/* Contact sales link */}
              <div className="mt-4 text-center">
                <span className="text-xs text-[#99a0ae]">Questions about pricing? </span>
                <button
                  type="button"
                  onClick={() => setContactSalesOpen(true)}
                  className="text-xs font-medium text-[#0066ff] hover:underline"
                >
                  Contact sales &rarr;
                </button>
              </div>
            </div>
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
