import { useState } from 'react';
import { ListIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';
import { SubscriptionStatus } from '@filone/shared';
import { SidebarNav } from './SidebarNav';
import { Banner } from './Banner';
import { getUsage, getBilling } from '../lib/api';
import { queryKeys } from '../lib/query-client.js';
import { daysUntil } from '../lib/time.js';

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: usage } = useQuery({ queryKey: queryKeys.usage, queryFn: getUsage });
  const { data: billing } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });
  const tenantStatus = usage?.tenantStatus;
  const isGracePeriod = billing?.subscription.status === SubscriptionStatus.GracePeriod;
  const graceDays = billing?.subscription.gracePeriodEndsAt
    ? daysUntil(billing.subscription.gracePeriodEndsAt)
    : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {tenantStatus === 'WRITE_LOCKED' && (
        <Banner variant="warning" action={{ label: 'Upgrade', href: '/billing' }}>
          {isGracePeriod
            ? `Your free trial has expired.${graceDays !== null ? ` ${graceDays} days left` : ''} to upgrade or download your data.`
            : 'Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.'}
        </Banner>
      )}
      {tenantStatus === 'DISABLED' && (
        <Banner variant="error" action={{ label: 'Manage account', href: '/billing' }}>
          Account disabled. Visit billing to restore access.
        </Banner>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <div
          className={`hidden flex-shrink-0 transition-all duration-200 lg:block ${collapsed ? 'w-20' : 'w-60'}`}
        >
          <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>

        {/* Mobile sidebar overlay */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            aria-hidden="true"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <div
          className={`fixed inset-y-0 left-0 z-40 w-72 transform transition-transform duration-200 lg:hidden ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <SidebarNav collapsed={false} onToggle={() => {}} onClose={() => setMobileOpen(false)} />
        </div>

        <main className="flex-1 overflow-auto bg-zinc-50">
          {/* Mobile top bar */}
          <div className="sticky top-0 z-20 flex h-12 flex-shrink-0 items-center border-b border-zinc-200 bg-white px-4 lg:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="flex items-center justify-center rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100"
            >
              <ListIcon size={20} />
            </button>
          </div>
          {children}
          <div className="h-10 shrink-0" aria-hidden="true" />
        </main>
      </div>
    </div>
  );
}
