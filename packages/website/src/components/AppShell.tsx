import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { AppHeader } from './AppHeader';
import { SidebarNav } from './SidebarNav';
import { getUsage } from '../lib/api';
import type { UsageResponse } from '@filone/shared';

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tenantStatus, setTenantStatus] = useState<UsageResponse['tenantStatus']>();

  useEffect(() => {
    getUsage()
      .then((data) => setTenantStatus(data.tenantStatus))
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — full height */}
      <div className={`flex-shrink-0 transition-all duration-200 ${collapsed ? 'w-20' : 'w-60'}`}>
        <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>

      {/* Header + main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <AppHeader />

        <main className="min-h-full flex-1 overflow-auto bg-zinc-50 p-6">
          {tenantStatus === 'WRITE_LOCKED' && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-800">
                Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.{' '}
                <Link to="/billing" className="font-semibold underline">
                  Upgrade &rarr;
                </Link>
              </p>
            </div>
          )}
          {tenantStatus === 'DISABLED' && (
            <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3">
              <p className="text-sm font-medium text-red-800">
                Egress limit exceeded. Your account has been temporarily disabled. Upgrade to
                restore access.{' '}
                <Link to="/billing" className="font-semibold underline">
                  Upgrade &rarr;
                </Link>
              </p>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
