import { formatBytes } from '@filone/shared';

import { daysRemainingLabel } from '../lib/time.js';
import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';

export type StatusBannersProps = {
  collapsed: boolean;
  isTrialing: boolean;
  trialDays: number | null;
  trialEndsLabel: string | undefined;
  storageUsed: number;
  storagePct: number;
  egressUsed: number;
  egressPct: number;
  /**
   * Whether the plan's allowances are known. A meter needs a denominator, and
   * the console only has one when it could read billing — the free tier's is
   * not a safe stand-in for a plan it never saw.
   */
  limitsKnown: boolean;
  graceDays: number | null;
  graceEndsLabel: string | undefined;
  isPastDue: boolean;
  isInactive: boolean;
  showTestIds: boolean;
};

export function StatusBanners({
  collapsed,
  isTrialing,
  trialDays,
  trialEndsLabel,
  storageUsed,
  storagePct,
  egressUsed,
  egressPct,
  limitsKnown,
  graceDays,
  graceEndsLabel,
  isPastDue,
  isInactive,
  showTestIds,
}: StatusBannersProps) {
  return (
    <>
      {!collapsed && isTrialing && limitsKnown && (
        <div className="px-2 py-3">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <p className="text-xs font-medium text-zinc-900" title={trialEndsLabel}>
              {trialDays !== null ? `${trialDays} days left in trial` : 'Trial active'}
            </p>
            <div className="mt-2.5 space-y-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-500">Storage</span>
                  <span className="text-zinc-700">{formatBytes(storageUsed)} / 1 TB</span>
                </div>
                <ProgressBar value={storagePct} size="sm" label="Storage usage" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-500">Egress</span>
                  <span className="text-zinc-700">{formatBytes(egressUsed)} / 2 TB</span>
                </div>
                <ProgressBar value={egressPct} size="sm" label="Egress usage" />
              </div>
            </div>
            <div className="mt-3">
              <Button
                id={showTestIds ? 'sidebar-upgrade-button' : undefined}
                variant="ghost"
                size="sm"
                href="/billing"
                className="w-full justify-center"
              >
                Upgrade
              </Button>
            </div>
          </div>
        </div>
      )}

      {!collapsed && isInactive && (
        <div className="px-2 py-3">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <p className="text-xs font-medium text-zinc-900">No active plan</p>
            <p className="mt-1 text-xs text-zinc-500">Choose a plan to start storing data.</p>
            <div className="mt-3">
              <Button
                id={showTestIds ? 'sidebar-choose-plan-button' : undefined}
                variant="primary"
                size="sm"
                href="/billing"
                className="w-full justify-center"
              >
                Choose a plan
              </Button>
            </div>
          </div>
        </div>
      )}

      {!collapsed && isPastDue && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
          <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
            Payment failed. Update your payment method to avoid losing access.
            {graceDays !== null ? ` ${daysRemainingLabel(graceDays)}.` : ''}
          </p>
          <div className="mt-3">
            <Button
              id={showTestIds ? 'sidebar-update-payment-button' : undefined}
              variant="primary"
              href="/billing"
              className="w-full justify-center text-xs"
            >
              Update payment
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
