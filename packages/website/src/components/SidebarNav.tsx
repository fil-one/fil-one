import {
  SquaresFourIcon,
  DatabaseIcon,
  KeyIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatTeardropDotsIcon,
  RobotIcon,
  UsersIcon,
  CreditCardIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';

import type { Permission } from '@filone/shared';
import { usePermissions } from '../lib/use-permissions.js';
import { useMembersSurface } from '../lib/use-members-surface.js';
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
  /**
   * Which side of the members-surface gate this entry sits on, for the two that
   * swap. A solo org outside the organizations beta has no members surface, so
   * `Organization` is not there — and `Billing`, which is a tab of that page
   * for everybody else, is a top-level entry instead.
   *
   * A permission cannot express it: all four roles hold `members.read`, and
   * `billing.view` is held by the same two roles on both sides of the gate.
   * Absent, the entry does not care either way.
   */
  membersSurface?: 'with' | 'without';
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

// Organization and Billing are the same entry seen from two orgs: where there
// is a members surface, billing is a tab of Organization and gets no entry of
// its own; where there is not, Organization is not a page and billing is all
// that would have been on it. Settings has no entry here at all: it's the
// caller's own account, reachable from `UserMenu` now that the sidebar splits
// org identity (this nav) from user identity (the menu under the name at the
// bottom) — a second way to reach it here would just be the same destination
// listed twice.
//
// Both are declared with the permission the destination needs — even
// `members.read`, which all four roles hold — so an entry stays hidden while
// `/me` is in flight rather than appearing for a caller whose role turns out
// not to reach it. The permission is not what decides whether the entry exists
// at all: see `membersSurface`.
const utilityNavItems: NavItem[] = [
  {
    path: '/organization',
    icon: UsersIcon,
    label: 'Organization',
    testId: 'nav-organization',
    permission: 'members.read',
    membersSurface: 'with',
  },
  {
    path: '/billing',
    icon: CreditCardIcon,
    label: 'Billing',
    testId: 'nav-billing',
    permission: 'billing.view',
    membersSurface: 'without',
  },
];

function UtilityNavLinks({ collapsed, matchRoute, onClose, showTestIds }: NavLinksProps) {
  const { has } = usePermissions();
  const membersSurface = useMembersSurface();
  const orgPath = useOrgPath();
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {utilityNavItems
        .filter((item) => !item.permission || has(item.permission))
        // Neither side of the gate is known while `/me` is in flight or after it
        // failed, so neither entry appears. Guessing would show one and then
        // swap it for the other, which is worse than a nav that fills in a
        // moment late.
        .filter((item) => {
          if (!item.membersSurface) return true;
          if (membersSurface.isPending || membersSurface.isError) return false;
          return item.membersSurface === (membersSurface.visible ? 'with' : 'without');
        })
        .map(({ path, icon: Icon, label, testId }) => {
          const isActive = Boolean(matchRoute({ to: orgPath(path) }));
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
              <Icon size={18} className={`flex-shrink-0 ${isActive ? '' : 'text-zinc-400'}`} />
              {!collapsed && <span>{label}</span>}
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
        className={`relative flex h-full flex-col border-zinc-200 bg-white ${showUserProfile ? 'border-r' : 'border-l'}`}
      >
        {/* Expand toggle (collapsed) — desktop only */}
        {showUserProfile && collapsed && (
          <div className="absolute -right-3 top-7 z-10 hidden -translate-y-1/2 lg:block">
            <Tooltip content="Expand sidebar" side="right">
              <button
                type="button"
                onClick={onToggle}
                aria-label="Expand sidebar"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-400 shadow-sm hover:text-zinc-600"
              >
                <CaretRightIcon size={14} />
              </button>
            </Tooltip>
          </div>
        )}

        {/* Org switcher + collapse toggle (desktop only) */}
        {showUserProfile && (
          <div className="relative flex h-14 flex-shrink-0 items-center px-2">
            <OrgSwitcherMenu
              orgName={me?.orgName ?? 'Organization'}
              logoUrl={me?.logoUrl}
              memberships={me?.memberships}
              activeOrgId={me?.orgId}
              collapsed={collapsed}
              testId={showTestIds ? 'org-switcher-button' : undefined}
            />

            {/* Spacer + collapse toggle (expanded) */}
            {!collapsed && (
              <>
                <div className="flex-1" />
                <Tooltip content="Collapse sidebar" side="right">
                  <button
                    type="button"
                    onClick={onToggle}
                    aria-label="Collapse sidebar"
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                  >
                    <CaretLeftIcon size={16} />
                  </button>
                </Tooltip>
              </>
            )}
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

        {/* Bottom utility nav */}
        <UtilityNavLinks
          collapsed={collapsed}
          matchRoute={matchRoute}
          onClose={onClose}
          showTestIds={showTestIds}
        />

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

        {/* Footer: user identity (also carries Documentation/Support now) + System status */}
        <div className="border-t border-zinc-200 p-2 flex flex-col gap-0.5">
          {showUserProfile && (
            <UserMenu
              src={me?.picture}
              initial={initial}
              displayName={displayName}
              collapsed={collapsed}
              testId={showTestIds ? 'user-menu-button' : undefined}
            />
          )}
          <StatusIndicator collapsed={collapsed} />
        </div>
      </nav>
    </div>
  );
}
