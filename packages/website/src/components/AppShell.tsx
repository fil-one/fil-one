import { useState } from 'react';
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
        <div className={`flex-shrink-0 transition-all duration-200 ${collapsed ? 'w-20' : 'w-60'}`}>
          <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>
        <main className="flex-1 overflow-auto bg-zinc-50">
          {children}
          <div className="h-10 shrink-0" aria-hidden="true" />
        </main>
      </div>
    </div>
  );
}
