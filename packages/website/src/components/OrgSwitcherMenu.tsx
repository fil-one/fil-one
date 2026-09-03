import { useState } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { CaretDownIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import type { OrgMembershipSummary } from '@filone/shared';

import { CreateOrganizationDialog } from './CreateOrganizationDialog.js';
import { OrgAvatar } from './OrgAvatar.js';
import { OrgSwitcher } from './OrgSwitcher.js';

type OrgSwitcherMenuProps = {
  orgName: string;
  logoUrl: string | undefined;
  memberships: OrgMembershipSummary[] | undefined;
  activeOrgId: string | undefined;
  collapsed: boolean;
  testId?: string;
};

/**
 * The org identity control, pinned at the top of the sidebar — separate from
 * `UserMenu` at the bottom, following the Vercel/Resend pattern of two
 * distinct controls rather than one combined user+org button.
 *
 * Built on Headless UI's `Menu` rather than a hand-rolled popover, matching
 * `RowActionsMenu`'s reasoning: a hand-rolled panel gets Escape and focus
 * return wrong (FIL-990).
 *
 * Always renders, even for a single-org account where `OrgSwitcher` itself
 * renders nothing: "Create organization" is reachable regardless of how many
 * orgs the caller already has.
 */
export function OrgSwitcherMenu({
  orgName,
  logoUrl,
  memberships,
  activeOrgId,
  collapsed,
  testId,
}: OrgSwitcherMenuProps) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Menu as="div" className="relative">
        <MenuButton
          data-testid={testId}
          aria-label={`Switch organization, current: ${orgName}`}
          className={[
            'flex items-center rounded-lg hover:bg-zinc-100 data-open:bg-zinc-100',
            collapsed ? 'w-full justify-center py-1.5' : 'w-full gap-2.5 px-2 py-1.5',
          ].join(' ')}
        >
          <OrgAvatar name={orgName} logoUrl={logoUrl} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-tight text-zinc-900">
                {orgName}
              </span>
              <CaretDownIcon size={14} className="flex-shrink-0 text-zinc-400" />
            </>
          )}
        </MenuButton>
        <MenuItems
          anchor="bottom start"
          className="z-50 mt-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-md focus:outline-none"
        >
          <OrgSwitcher
            inMenu
            memberships={memberships}
            activeOrgId={activeOrgId}
            testId="org-switcher"
          />
          <MenuItem>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-600 transition-colors data-focus:bg-zinc-100 data-focus:text-zinc-900"
            >
              <PlusIcon size={16} className="flex-shrink-0 text-zinc-400" />
              Create organization
            </button>
          </MenuItem>
        </MenuItems>
      </Menu>
      <CreateOrganizationDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
