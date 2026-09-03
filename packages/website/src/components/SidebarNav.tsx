import {
  SquaresFourIcon,
  DatabaseIcon,
  KeyIcon,
  SidebarSimpleIcon,
  ChatTeardropDotsIcon,
  RobotIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';

import type { Permission } from '@filone/shared';
import { usePermissions } from '../lib/use-permissions.js';
import { useOrgPath } from '../lib/use-org-path.js';
import { useSidebarData } from './use-sidebar-data.js';

import { OrgSwitcherMenu } from './OrgSwitcherMenu.js';
import { StatusBanners } from './SidebarStatusBanners.js';
import { StatusIndicator } from './StatusIndicator.js';
import { Tooltip } from './Tooltip.js';
import { UserMenu } from './UserMenu.js';

type SidebarNavProps = {
  collapsed: boolean;
  onToggle: () => void;
  onClose?: () => void;
  showUserProfile?: boolean;
  // When false, omit page-unique e2e identifiers (ids/data-testids) so the
  // secondary mobile-drawer copy doesn't duplicate the desktop sidebar's
  // selectors. The primary desktop sidebar passes true.
  showTestIds: boolean;
};

type NavItem = {
  path: string;
  icon: React.ElementType;
  label: string;
  testId: string;
  /** What the destination needs. Omitted, every member sees the entry. */
  permission?: Permission;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    items: [
      { path: '/dashboard', icon: SquaresFourIcon, label: 'Dashboard', testId: 'nav-dashboard' },
    ],
  },
  {
    label: 'Storage',
    items: [
      { path: '/buckets', icon: DatabaseIcon, label: 'Buckets', testId: 'nav-buckets' },
      {
        path: '/api-keys',
        icon: KeyIcon,
        label: 'API Keys',
        testId: 'nav-api-keys',
        // ReadOnly holds no `keys.*`, so the list request is refused and the
        // page has nothing but the connection reference to offer.
        permission: 'keys.manage_own',
      },
    ],
  },
  {
    label: 'AI Tools',
    items: [
      {
        path: '/bucket-intelligence',
        icon: ChatTeardropDotsIcon,
        label: 'Bucket Intelligence',
        testId: 'nav-bucket-intelligence',
      },
      {
        path: '/ai-agent-toolkit',
        icon: RobotIcon,
        label: 'AI Agent Toolkit',
        testId: 'nav-ai-agent-toolkit',
      },
    ],
  },
];

type NavLinksProps = {
  collapsed: boolean;
  matchRoute: ReturnType<typeof useMatchRoute>;
  onClose?: () => void;
  // Suppress stable test ids on the secondary (mobile drawer) copy so e2e
  // selectors stay page-unique. See SidebarNav `showTestIds`.
  showTestIds: boolean;
};

function NavLinks({ collapsed, matchRoute, onClose, showTestIds }: NavLinksProps) {
  const { has } = usePermissions();
  const orgPath = useOrgPath();
  return (
    <div className="flex flex-col p-2">
      {navGroups.map((group, gi) => (
        <div key={gi} className={gi > 0 ? 'mt-2' : ''}>
          {!collapsed && group.label && (
            <p className="mb-1 px-3 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              {group.label}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items
              .filter((item) => !item.permission || has(item.permission))
              .map(({ path, icon: Icon, label, testId }) => {
                const isActive = Boolean(
                  matchRoute({ to: orgPath(path), fuzzy: path === '/buckets' }),
                );
                const link = (
                  <Link
                    key={path}
                    to={orgPath(path)}
                    data-testid={showTestIds ? testId : undefined}
                    aria-label={label}
                    onClick={onClose}
                    className={[
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                      collapsed ? 'justify-center' : '',
                      isActive ? 'bg-brand-50 text-brand-700' : 'text-zinc-600 hover:bg-zinc-100',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <Icon
                      size={18}
                      className={`flex-shrink-0 ${isActive ? '' : 'text-zinc-400'}`}
                    />
                    {!collapsed && <span className="flex-1">{label}</span>}
                  </Link>
                );
                if (collapsed) {
                  return (
                    <Tooltip key={path} content={label} side="right">
                      {link}
                    </Tooltip>
                  );
                }
                return <div key={path}>{link}</div>;
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SidebarNav({
  collapsed,
  onToggle,
  onClose,
  showUserProfile = true,
  showTestIds,
}: SidebarNavProps) {
  const matchRoute = useMatchRoute();

  const {
    me,
    displayName,
    initial,
    isTrialing,
    isPastDue,
    isInactive,
    trialDays,
    trialEndsLabel,
    graceDays,
    graceEndsLabel,
    storageUsed,
    storagePct,
    egressUsed,
    egressPct,
    limitsKnown,
  } = useSidebarData();

  return (
    <div className="h-full">
      <nav
        // No background or border of its own: on desktop it sits on the app's
        // white canvas beside the inset content panel (the panel carries the
        // chrome now). The mobile drawer supplies its own white background.
        className="relative flex h-full flex-col"
      >
        {/* Header (desktop only): a slim toolbar row carrying the collapse
            toggle, above the full-width org switcher. The toggle sits here
            rather than in the org row so the org button can own the full width;
            the `SidebarSimple` glyph reads as "toggle panel" in both states, so
            it needs no direction and no floating edge treatment. */}
        {showUserProfile && (
          <div className="flex flex-shrink-0 flex-col gap-1 px-2 pt-2 pb-1">
            <div className={collapsed ? 'flex justify-center' : 'flex justify-end'}>
              <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                >
                  <SidebarSimpleIcon size={18} />
                </button>
              </Tooltip>
            </div>
            <OrgSwitcherMenu
              orgName={me?.orgName ?? 'Organization'}
              logoUrl={me?.logoUrl}
              memberships={me?.memberships}
              activeOrgId={me?.orgId}
              collapsed={collapsed}
              testId={showTestIds ? 'org-switcher-button' : undefined}
            />
          </div>
        )}

        {/* Primary nav items */}
        <NavLinks
          collapsed={collapsed}
          matchRoute={matchRoute}
          onClose={onClose}
          showTestIds={showTestIds}
        />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status banners */}
        <StatusBanners
          collapsed={collapsed}
          showTestIds={showTestIds}
          isTrialing={isTrialing}
          trialDays={trialDays}
          trialEndsLabel={trialEndsLabel}
          storageUsed={storageUsed}
          storagePct={storagePct}
          egressUsed={egressUsed}
          egressPct={egressPct}
          limitsKnown={limitsKnown}
          graceDays={graceDays}
          graceEndsLabel={graceEndsLabel}
          isPastDue={isPastDue}
          isInactive={isInactive}
        />

        {/* Footer: user identity (also carries Documentation/Support now). System
            status has moved to the content window's bottom bar on desktop; it
            stays here only in the mobile drawer, which has no such bar. */}
        <div className="p-2 flex flex-col gap-0.5">
          {showUserProfile && (
            <UserMenu
              src={me?.picture}
              initial={initial}
              displayName={displayName}
              collapsed={collapsed}
              testId={showTestIds ? 'user-menu-button' : undefined}
            />
          )}
          {!showUserProfile && <StatusIndicator collapsed={collapsed} />}
        </div>
      </nav>
    </div>
  );
}
