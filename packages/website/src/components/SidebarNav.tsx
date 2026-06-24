import { useEffect, useRef, useState } from 'react';
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
  SignOutIcon,
  QuestionIcon,
  ChatTeardropDotsIcon,
  RobotIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';

import { DOCS_URL, formatBytes } from '@filone/shared';
import { logout } from '../lib/api.js';
import { useSidebarData } from './use-sidebar-data.js';

import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';
import { StatusIndicator } from './StatusIndicator.js';
import { Tooltip } from './Tooltip.js';

type SidebarNavProps = {
  collapsed: boolean;
  onToggle: () => void;
  onClose?: () => void;
  showUserProfile?: boolean;
};

type NavItem = {
  path: string;
  icon: React.ElementType;
  label: string;
  testId: string;
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
      { path: '/api-keys', icon: KeyIcon, label: 'API Keys', testId: 'nav-api-keys' },
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
};

function NavLinks({ collapsed, matchRoute, onClose }: NavLinksProps) {
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
            {group.items.map(({ path, icon: Icon, label, testId }) => {
              const isActive = Boolean(matchRoute({ to: path, fuzzy: path === '/buckets' }));
              const link = (
                <Link
                  key={path}
                  to={path}
                  data-testid={testId}
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

const utilityNavItems: NavItem[] = [
  { path: '/billing', icon: CreditCardIcon, label: 'Billing', testId: 'nav-billing' },
  { path: '/settings', icon: GearIcon, label: 'Settings', testId: 'nav-settings' },
];

function UtilityNavLinks({ collapsed, matchRoute, onClose }: NavLinksProps) {
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {utilityNavItems.map(({ path, icon: Icon, label, testId }) => {
        const isActive = Boolean(matchRoute({ to: path }));
        const link = (
          <Link
            key={path}
            to={path}
            data-testid={testId}
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

type StatusBannersProps = {
  collapsed: boolean;
  isTrialing: boolean;
  trialDays: number | null;
  trialEndsLabel: string | undefined;
  storageUsed: number;
  storagePct: number;
  egressUsed: number;
  egressPct: number;
  graceDays: number | null;
  graceEndsLabel: string | undefined;
  isPastDue: boolean;
};

function StatusBanners({
  collapsed,
  isTrialing,
  trialDays,
  trialEndsLabel,
  storageUsed,
  storagePct,
  egressUsed,
  egressPct,
  graceDays,
  graceEndsLabel,
  isPastDue,
}: StatusBannersProps) {
  return (
    <>
      {!collapsed && isTrialing && (
        <div className="border-t border-zinc-200 px-3 py-3">
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
                id="sidebar-upgrade-button"
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

      {!collapsed && isPastDue && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
          <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
            Payment failed. Update your payment method to avoid losing access.
            {graceDays !== null ? ` ${graceDays} days remaining.` : ''}
          </p>
          <div className="mt-3">
            <Button
              id="sidebar-update-payment-button"
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

export type HelpMenuProps = {
  collapsed: boolean;
  helpMenuOpen: boolean;
  helpMenuRef: React.RefObject<HTMLDivElement | null>;
  helpButtonRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onClose?: () => void;
};

export function HelpMenu({
  collapsed,
  helpMenuOpen,
  helpMenuRef,
  helpButtonRef,
  onToggle,
  onClose,
}: HelpMenuProps) {
  return (
    <div className="relative">
      {collapsed ? (
        <Tooltip content="Help" side="right">
          <button
            ref={helpButtonRef}
            type="button"
            onClick={onToggle}
            aria-label="Help"
            className="flex w-full items-center justify-center rounded-lg py-2 text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <QuestionIcon size={18} className="text-zinc-400" />
          </button>
        </Tooltip>
      ) : (
        <button
          ref={helpButtonRef}
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100"
        >
          <QuestionIcon size={16} className="flex-shrink-0 text-zinc-400" />
          Help
        </button>
      )}
      {helpMenuOpen && (
        <div
          ref={helpMenuRef}
          className="absolute bottom-full left-2 z-50 mb-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
        >
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <BookOpenIcon size={18} className="flex-shrink-0 text-zinc-400" />
            Documentation
          </a>
          <Link
            to="/support"
            onClick={onClose}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <ChatCircleIcon size={18} className="flex-shrink-0 text-zinc-400" />
            Talk to an expert
          </Link>
        </div>
      )}
    </div>
  );
}

export function SidebarNav({
  collapsed,
  onToggle,
  onClose,
  showUserProfile = true,
}: SidebarNavProps) {
  const matchRoute = useMatchRoute();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);

  const {
    me,
    displayName,
    initial,
    isTrialing,
    isPastDue,
    trialDays,
    trialEndsLabel,
    graceDays,
    graceEndsLabel,
    storageUsed,
    storagePct,
    egressUsed,
    egressPct,
  } = useSidebarData();

  useEffect(() => {
    if (!userMenuOpen && !helpMenuOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        userMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node) &&
        userButtonRef.current &&
        !userButtonRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
      if (
        helpMenuOpen &&
        helpMenuRef.current &&
        !helpMenuRef.current.contains(e.target as Node) &&
        helpButtonRef.current &&
        !helpButtonRef.current.contains(e.target as Node)
      ) {
        setHelpMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [userMenuOpen, helpMenuOpen]);

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

        {/* User profile + collapse toggle (desktop only) */}
        {showUserProfile && (
          <div className="relative flex h-14 flex-shrink-0 items-center px-2">
            <button
              ref={userButtonRef}
              type="button"
              data-testid="user-profile"
              onClick={() => setUserMenuOpen((o) => !o)}
              className={[
                'flex items-center rounded-lg hover:bg-zinc-100',
                collapsed ? 'w-full justify-center py-1.5' : 'gap-2.5 px-2 py-1.5',
              ].join(' ')}
            >
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                {initial}
              </span>
              {!collapsed && (
                <div className="min-w-0 overflow-hidden text-left">
                  <p className="truncate text-sm font-medium leading-tight text-zinc-900">
                    {displayName}
                  </p>
                  {me?.orgName && (
                    <p className="truncate text-xs leading-tight text-zinc-500">{me.orgName}</p>
                  )}
                </div>
              )}
            </button>

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

            {/* User dropdown */}
            {userMenuOpen && (
              <div
                ref={userMenuRef}
                className="absolute left-2 top-14 z-50 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
              >
                <button
                  type="button"
                  id="user-menu-logout-button"
                  onClick={logout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
                >
                  <SignOutIcon size={18} className="flex-shrink-0 text-zinc-400" />
                  Log out
                </button>
              </div>
            )}
          </div>
        )}

        {/* Primary nav items */}
        <NavLinks collapsed={collapsed} matchRoute={matchRoute} onClose={onClose} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom utility nav */}
        <UtilityNavLinks collapsed={collapsed} matchRoute={matchRoute} onClose={onClose} />

        {/* Status banners */}
        <StatusBanners
          collapsed={collapsed}
          isTrialing={isTrialing}
          trialDays={trialDays}
          trialEndsLabel={trialEndsLabel}
          storageUsed={storageUsed}
          storagePct={storagePct}
          egressUsed={egressUsed}
          egressPct={egressPct}
          graceDays={graceDays}
          graceEndsLabel={graceEndsLabel}
          isPastDue={isPastDue}
        />

        {/* Footer: Help + System status */}
        <div className="border-t border-zinc-200 p-2 flex flex-col gap-0.5">
          <HelpMenu
            collapsed={collapsed}
            helpMenuOpen={helpMenuOpen}
            helpMenuRef={helpMenuRef}
            helpButtonRef={helpButtonRef}
            onToggle={() => setHelpMenuOpen((o) => !o)}
            onClose={onClose}
          />
          <StatusIndicator collapsed={collapsed} />
        </div>
      </nav>
    </div>
  );
}
