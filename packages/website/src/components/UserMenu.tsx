import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CaretUpDownIcon,
  ChatCircleIcon,
  GearIcon,
  SignOutIcon,
} from '@phosphor-icons/react/dist/ssr';

import { DOCS_URL } from '@filone/shared';
import { logout } from '../lib/api.js';
import { BaseLink } from './BaseLink.js';
import { UserAvatar } from './UserAvatar.js';

const itemClassName =
  'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors data-focus:bg-zinc-100 data-focus:text-zinc-900';

type UserMenuProps = {
  src: string | undefined;
  initial: string;
  displayName: string;
  collapsed: boolean;
  testId?: string;
};

/**
 * The account identity control, separate from `OrgSwitcherMenu`: this one is
 * about the signed-in person, not the org they're viewing, so it sits in the
 * footer rather than at the top — smaller, and one level down in visual
 * weight from the org switcher, matching the Vercel/Resend references.
 *
 * Also absorbs what used to be the sidebar's separate Help menu (Documentation,
 * and "Talk to an expert", renamed here to Support since it is the same
 * destination as the sidebar's Organization/Billing-style utility nav would
 * name it): one menu under the account is where people already look for
 * settings and log out, so a second, adjacent popover for docs and support
 * was a second place to check rather than a useful distinction.
 *
 * Opens upward (`anchor="top start"`) since it is the last thing in the
 * sidebar's footer.
 */
export function UserMenu({ src, initial, displayName, collapsed, testId }: UserMenuProps) {
  return (
    <Menu as="div" className="relative">
      <MenuButton
        data-testid={testId}
        aria-label={`User menu for ${displayName}`}
        className={[
          'flex items-center rounded-lg py-1.5 text-zinc-500 hover:bg-zinc-100 data-open:bg-zinc-100',
          collapsed ? 'w-full justify-center' : 'w-full gap-2.5 px-2',
        ].join(' ')}
      >
        {/* Smaller than the 11px token floor on purpose: two initials in a 20px
            circle. `text-zinc-800` is re-asserted so the size override cannot
            drop the base colour. */}
        <UserAvatar src={src} initial={initial} className="h-5 w-5 text-[10px] text-zinc-800" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-xs leading-tight">
              {displayName}
            </span>
            {/* The button carries no other chrome; the chevron is what says it
                opens a menu rather than navigating. Up-down because the menu
                opens upward from the footer. */}
            <CaretUpDownIcon size={14} className="flex-shrink-0 text-zinc-400" />
          </>
        )}
      </MenuButton>
      <MenuItems
        anchor="top start"
        className="z-50 mb-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-md focus:outline-none"
      >
        <MenuItem as={BaseLink} href="/settings" className={itemClassName}>
          <GearIcon size={13} className="flex-shrink-0 text-zinc-400" />
          Settings
        </MenuItem>
        <MenuItem as={BaseLink} href="/support" className={itemClassName}>
          <ChatCircleIcon size={13} className="flex-shrink-0 text-zinc-400" />
          Support
        </MenuItem>
        <MenuItem as={BaseLink} href={DOCS_URL} className={itemClassName}>
          <BookOpenIcon size={13} className="flex-shrink-0 text-zinc-400" />
          Documentation
          <ArrowUpRightIcon size={12} className="ml-auto flex-shrink-0 text-zinc-400" />
        </MenuItem>
        <div className="my-1 border-t border-zinc-100" />
        <MenuItem>
          <button
            type="button"
            id="user-menu-logout-button"
            onClick={logout}
            className={itemClassName}
          >
            <SignOutIcon size={13} className="flex-shrink-0 text-zinc-400" />
            Log out
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}
