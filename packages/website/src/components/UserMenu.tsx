import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { CaretUpDownIcon, GearIcon, SignOutIcon } from '@phosphor-icons/react/dist/ssr';

import { logout } from '../lib/api.js';
import { BaseLink } from './BaseLink.js';
import { UserAvatar } from './UserAvatar.js';

const itemClassName =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors data-focus:bg-zinc-100 data-focus:text-zinc-900';

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
 * Holds only what is about the account: Settings and Log out. Documentation
 * and Support are rows in the sidebar footer above it, in view without
 * opening a menu.
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
        {/* `text-meta` is the console's smallest supported step, for two
            initials in a 20px circle. `text-zinc-800` is re-asserted so the
            size override cannot drop the base colour. */}
        <UserAvatar src={src} initial={initial} className="h-5 w-5 text-meta text-zinc-800" />
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
      {/* No outline on the panel: it holds focus while the arrow keys move
          between items, so the highlighted item shows a keyboard user where
          they are. */}
      <MenuItems
        anchor="top start"
        className="z-50 mb-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-md outline-none"
      >
        <MenuItem as={BaseLink} href="/settings" className={itemClassName}>
          <GearIcon size={13} className="flex-shrink-0 text-zinc-400" />
          Settings
        </MenuItem>
        <div className="my-1 border-t border-zinc-100" />
        {/* The MenuItem is the button: wrapping one, it replaces the child's id with its own. */}
        <MenuItem
          as="button"
          type="button"
          id="user-menu-logout-button"
          onClick={logout}
          className={itemClassName}
        >
          <SignOutIcon size={13} className="flex-shrink-0 text-zinc-400" />
          Log out
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}
