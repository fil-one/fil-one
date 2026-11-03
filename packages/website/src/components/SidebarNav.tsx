import {
  ArrowUpRightIcon,
  BookOpenIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  CreditCardIcon,
  DatabaseIcon,
  KeyIcon,
  SquaresFourIcon,
  UsersIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';

import { DOCS_URL } from '@filone/shared';
import type { Permission } from '@filone/shared';
import { usePermissions } from '../lib/use-permissions.js';
import { useSidebarData } from './use-sidebar-data.js';

import { BaseLink } from './BaseLink.js';
import { OrgSwitcherMenu } from './OrgSwitcherMenu.js';
import { ReportBugButton } from './ReportBugButton.js';
import { StatusBanners } from './SidebarStatusBanners.js';
import { StatusIndicator } from './StatusIndicator.js';
import { Tooltip } from './Tooltip.js';
import { UserMenu } from './UserMenu.js';

type SidebarNavProps = {
  collapsed: boolean;
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
  /** Part of the organizations beta, so shown only to orgs in it. */
  beta?: boolean;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    // Unlabelled: with two storage pages, a "Storage" heading only added noise.
    items: [
      { path: '/dashboard', icon: SquaresFourIcon, label: 'Dashboard', testId: 'nav-dashboard' },
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
    // The org switcher menu keeps Edit organization; these live only here.
    label: 'Organization',
    items: [
      {
        path: '/members',
        icon: UsersIcon,
        label: 'Members',
        testId: 'nav-members',
        permission: 'members.read',
        beta: true,
      },
      {
        path: '/billing',
        icon: CreditCardIcon,
        label: 'Billing',
        testId: 'nav-billing',
        permission: 'billing.view',
      },
      {
        path: '/audit',
        icon: ClockCounterClockwiseIcon,
        label: 'Audit log',
        testId: 'nav-audit',
        permission: 'audit.view',
        beta: true,
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
  const { has, orgsBeta } = usePermissions();
  // A group whose every page the caller cannot open is left out, label and all.
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => (!item.permission || has(item.permission)) && (orgsBeta || !item.beta),
      ),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <div className="flex flex-col p-2">
      {visibleGroups.map((group, gi) => (
        <div key={gi} className={gi > 0 ? 'mt-4' : ''}>
          {!collapsed && group.label && (
            <p className="mb-1 px-3 text-meta font-medium uppercase tracking-wide text-zinc-500">
              {group.label}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map(({ path, icon: Icon, label, testId }) => {
              const isActive = Boolean(matchRoute({ to: path, fuzzy: path === '/buckets' }));
              const link = (
                <Link
                  key={path}
                  to={path}
                  data-testid={showTestIds ? testId : undefined}
                  aria-label={label}
                  onClick={onClose}
                  className={[
                    'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-ui transition-colors',
                    collapsed ? 'justify-center' : '',
                    isActive ? 'bg-brand-50 text-brand-700' : 'text-zinc-600 hover:bg-zinc-100',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <Icon size={16} className={`flex-shrink-0 ${isActive ? '' : 'text-zinc-400'}`} />
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

const helpLinks = [
  {
    href: DOCS_URL,
    icon: BookOpenIcon,
    label: 'Documentation',
    testId: 'sidebar-docs-link',
    external: true,
  },
  {
    href: '/support',
    icon: ChatCircleIcon,
    label: 'Support',
    testId: 'sidebar-support-link',
    external: false,
  },
];

type HelpLinksProps = Omit<NavLinksProps, 'matchRoute'>;

/**
 * Documentation and Support, in the footer of both the sidebar and the mobile
 * drawer, so they are in view without opening a menu. A step quieter than the
 * page links (smaller grey text, no active state): they are places to get
 * help, not pages of the org.
 */
function HelpLinks({ collapsed, onClose, showTestIds }: HelpLinksProps) {
  return (
    <>
      {helpLinks.map(({ href, icon: Icon, label, testId, external }) => {
        const link = (
          <BaseLink
            href={href}
            data-testid={showTestIds ? testId : undefined}
            aria-label={label}
            onClick={onClose}
            className={[
              'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:brand-outline',
              collapsed ? 'justify-center' : '',
            ].join(' ')}
          >
            <Icon size={16} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
            {!collapsed && (
              <>
                <span className="flex-1">{label}</span>
                {external && (
                  <ArrowUpRightIcon
                    size={12}
                    className="flex-shrink-0 text-zinc-400"
                    aria-hidden="true"
                  />
                )}
              </>
            )}
          </BaseLink>
        );
        if (collapsed) {
          return (
            <Tooltip key={href} content={label} side="right">
              {link}
            </Tooltip>
          );
        }
        return <div key={href}>{link}</div>;
      })}
    </>
  );
}

export function SidebarNav({
  collapsed,
  onClose,
  showUserProfile = true,
  showTestIds,
}: SidebarNavProps) {
  const matchRoute = useMatchRoute();
  // Without an active plan, `_app.tsx` swaps every page for the billing gate,
  // so the page links and the status banners (the same "no active plan" fact
  // the gate states) are dead ends and are left out.
  const hideNavLinks = !usePermissions().billingActive;

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
        {/* Header (desktop only): the full-width org switcher. The collapse
            toggle now lives in the utility bar under the content window. */}
        {showUserProfile && (
          <div className="flex flex-shrink-0 flex-col gap-1 px-2 pt-2 pb-1">
            <OrgSwitcherMenu
              collapsed={collapsed}
              testId={showTestIds ? 'org-switcher-button' : undefined}
            />
          </div>
        )}

        {!hideNavLinks && (
          <NavLinks
            collapsed={collapsed}
            matchRoute={matchRoute}
            onClose={onClose}
            showTestIds={showTestIds}
          />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {!hideNavLinks && (
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
        )}

        {/* Footer: Documentation and Support, then user identity. Bug report
            and system status sit in the content window's bottom bar on
            desktop; they appear here only in the mobile drawer, which has no
            such bar. */}
        <div className="p-2 flex flex-col gap-0.5">
          <HelpLinks collapsed={collapsed} onClose={onClose} showTestIds={showTestIds} />
          {/* Sets the help links apart from the account and app controls below. */}
          <div className="my-1 border-t border-zinc-100" aria-hidden="true" />
          {showUserProfile && (
            <UserMenu
              src={me?.picture}
              initial={initial}
              displayName={displayName}
              collapsed={collapsed}
              testId={showTestIds ? 'user-menu-button' : undefined}
            />
          )}
          {!showUserProfile && (
            <>
              <ReportBugButton variant="row" />
              <StatusIndicator variant="row" />
            </>
          )}
        </div>
      </nav>
    </div>
  );
}
