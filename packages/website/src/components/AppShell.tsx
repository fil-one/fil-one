import { useState } from 'react';
import { AppHeader } from './AppHeader';
import { SidebarNav } from './SidebarNav';

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Top header — full width */}
      <AppHeader collapsed={collapsed} />

      {/* Body row: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className={`flex-shrink-0 transition-all duration-200 ${collapsed ? 'w-16' : 'w-60'}`}>
          <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>

        {/* Main content */}
        <main className="min-h-full flex-1 overflow-auto bg-zinc-50 p-6">{children}</main>
      </div>
    </div>
  );
}
