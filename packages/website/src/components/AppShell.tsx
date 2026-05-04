import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SidebarNav } from './SidebarNav';
import { getUsage } from '../lib/api';
import { queryKeys } from '../lib/query-client.js';

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  const { data: usage } = useQuery({ queryKey: queryKeys.usage, queryFn: getUsage });
  const tenantStatus = usage?.tenantStatus;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — full height */}
      <div className={`flex-shrink-0 transition-all duration-200 ${collapsed ? 'w-20' : 'w-60'}`}>
        <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-zinc-50">
        {tenantStatus === 'WRITE_LOCKED' && (
          <div className="px-10 pt-10">
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-800">
                Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.{' '}
                <Link to="/billing" className="font-semibold underline">
                  Upgrade &rarr;
                </Link>
              </p>
            </div>
          </div>
        )}
        {tenantStatus === 'DISABLED' && (
          <div className="px-10 pt-10">
            <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3">
              <p className="text-sm font-medium text-red-800">
                Egress limit exceeded. Your account has been temporarily disabled. Upgrade to
                restore access.{' '}
                <Link to="/billing" className="font-semibold underline">
                  Upgrade &rarr;
                </Link>
              </p>
            </div>
          </div>
        )}
        {children}
        <div className="h-10 shrink-0" aria-hidden="true" />
      </main>
    </div>
  );
}
