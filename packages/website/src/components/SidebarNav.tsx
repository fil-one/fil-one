import {
  SquaresFourIcon,
  DatabaseIcon,
  KeyIcon,
  CreditCardIcon,
  GearIcon,
  CaretLeftIcon,
  CaretRightIcon,
  BookOpenIcon,
  ChatCircleIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { ProgressBar } from '@hyperspace/ui/ProgressBar';
import { Button } from '@hyperspace/ui/Button';

type SidebarNavProps = {
  collapsed: boolean;
  onToggle: () => void;
};

type NavItem = {
  path: string;
  icon: React.ElementType;
  label: string;
};

const navItems: NavItem[] = [
  { path: '/dashboard', icon: SquaresFourIcon, label: 'Dashboard' },
  { path: '/buckets', icon: DatabaseIcon, label: 'Buckets' },
  { path: '/api-keys', icon: KeyIcon, label: 'API & Keys' },
  { path: '/billing', icon: CreditCardIcon, label: 'Billing' },
  { path: '/settings', icon: GearIcon, label: 'Settings' },
];

export function SidebarNav({ collapsed, onToggle }: SidebarNavProps) {
  const matchRoute = useMatchRoute();

  return (
    <nav className="flex h-full flex-col border-r border-zinc-200 bg-white">
      {/* Logo + collapse toggle */}
      <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 px-3">
        <div className="flex items-center gap-2 overflow-hidden">
          {/* Logo mark */}
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            F
          </span>
          {!collapsed && (
            <span className="truncate text-sm font-semibold text-zinc-900">
              Fil Hyperspace
            </span>
          )}
        </div>

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          {collapsed ? <CaretRightIcon size={16} /> : <CaretLeftIcon size={16} />}
        </button>
      </div>

      {/* Storage bar (expanded only) */}
      {!collapsed && (
        <div className="border-b border-zinc-200 px-3 py-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Storage
            </span>
            <span className="text-xs text-zinc-700">0%</span>
          </div>
          {/* UNKNOWN: storage usage value should come from an API/context — using 0 as placeholder */}
          <ProgressBar value={0} size="sm" label="Storage usage" />
        </div>
      )}

      {/* Primary nav items */}
      <div className="flex flex-col gap-0.5 p-2">
        {navItems.map(({ path, icon: Icon, label }) => {
          const isActive = Boolean(
            matchRoute({ to: path, fuzzy: path === '/buckets' }),
          );

          return (
            <Link
              key={path}
              to={path}
              title={collapsed ? label : undefined}
              className={[
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                collapsed ? 'justify-center' : '',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-zinc-600 hover:bg-zinc-100',
              ]
                .filter(Boolean)
                .join(' ')}
              activeProps={{ className: 'bg-brand-50 text-brand-700' }}
            >
              <Icon size={18} className="flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </Link>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Trial section (expanded only) */}
      {!collapsed && (
        <div className="border-t border-zinc-200 px-3 py-4">
          <p className="text-xs text-zinc-500">14 days left in trial</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            Upgrade to continue using Filstor.
          </p>
          <div className="mt-3">
            {/* UNKNOWN: upgrade href — using /billing as the most defensible default */}
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Upgrade
            </Button>
          </div>
        </div>
      )}

      {/* Bottom links */}
      <div className="flex flex-col gap-0.5 border-t border-zinc-200 p-2">
        <a
          href="#"
          title={collapsed ? 'Documentation' : undefined}
          className={[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100',
            collapsed ? 'justify-center' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          target="_blank"
          rel="noopener noreferrer"
        >
          <BookOpenIcon size={18} className="flex-shrink-0" />
          {!collapsed && <span>Documentation</span>}
        </a>

        <Link
          to="/support"
          title={collapsed ? 'Talk to an expert' : undefined}
          className={[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100',
            collapsed ? 'justify-center' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <ChatCircleIcon size={18} className="flex-shrink-0" />
          {!collapsed && <span>Talk to an expert</span>}
        </Link>
      </div>
    </nav>
  );
}
