import { useState } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import {
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  CreditCardIcon,
  PencilSimpleIcon,
  PlusIcon,
  UsersIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { OrgMembershipSummary } from '@filone/shared';

import { BaseLink } from './BaseLink.js';
import { CreateOrganizationDialog } from './CreateOrganizationDialog.js';
import { OrgAvatar } from './OrgAvatar.js';
import { OrgSwitcher } from './OrgSwitcher.js';
import { usePermissions } from '../lib/use-permissions.js';

type OrgSwitcherMenuProps = {
  orgName: string;
  logoUrl: string | undefined;
  memberships: OrgMembershipSummary[] | undefined;
  activeOrgId: string | undefined;
  collapsed: boolean;
  testId?: string;
};

/** One row's worth of chrome, shared by every item and link in the panel. */
const itemClassName =
  'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors data-focus:bg-zinc-100 data-focus:text-zinc-900';

/**
 * The org identity control, pinned at the top of the sidebar, separate from
 * `UserMenu` at the bottom, following the Vercel/Resend pattern of two distinct
 * controls rather than one combined user+org button.
 *
 * The name at the top is the org's identity; Edit organization, Members,
 * Billing, and Audit log are the surfaces that name governs, each its own page
 * (Edit organization also carries the danger zone, gated separately on
 * `org.delete` since Owner and Admin can rename but only Owner can delete).
 * Below a divider the switcher lists the caller's other orgs, and Create
 * organization sits at the foot. Each org action is gated on the permission
 * its destination needs, so a role is never offered a page the server would
 * refuse it.
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
  const { has } = usePermissions();

  return (
    <>
      <Menu as="div" className="relative w-full">
        {({ close }) => (
          <>
            <MenuButton
              data-testid={testId}
              aria-label={`Organization menu for ${orgName}`}
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
              className="z-50 mt-1 w-60 rounded-lg border border-zinc-200 bg-white p-1 shadow-md focus:outline-none"
            >
              {has('org.rename') && (
                <MenuItem
                  as={BaseLink}
                  href="/organization"
                  data-testid="org-menu-edit"
                  className={itemClassName}
                >
                  <PencilSimpleIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Edit organization
                </MenuItem>
              )}
              {has('members.read') && (
                <MenuItem as={BaseLink} href="/members" className={itemClassName}>
                  <UsersIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Members
                </MenuItem>
              )}
              {has('billing.view') && (
                <MenuItem as={BaseLink} href="/billing" className={itemClassName}>
                  <CreditCardIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Billing
                </MenuItem>
              )}
              {has('audit.view') && (
                <MenuItem as={BaseLink} href="/audit" className={itemClassName}>
                  <ClockCounterClockwiseIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Audit log
                </MenuItem>
              )}

              <div className="my-1 border-t border-zinc-100" />
              <OrgSwitcher
                inMenu
                memberships={memberships}
                activeOrgId={activeOrgId}
                testId="org-switcher"
                onClose={close}
              />
              <MenuItem>
                <button type="button" onClick={() => setCreateOpen(true)} className={itemClassName}>
                  <PlusIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Create organization
                </button>
              </MenuItem>
            </MenuItems>
          </>
        )}
      </Menu>
      <CreateOrganizationDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
