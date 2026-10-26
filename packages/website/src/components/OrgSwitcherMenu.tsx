import { useState } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from '@headlessui/react';
import { CaretDownIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';

import { BaseLink } from './BaseLink.js';
import { CreateOrganizationDialog } from './CreateOrganizationDialog.js';
import { OrgAvatar } from './OrgAvatar.js';
import { OrgSwitcher } from './OrgSwitcher.js';
import { getMe } from '../lib/api.js';
import { usePendingOrgSwitchTarget } from '../lib/active-org.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { usePermissions } from '../lib/use-permissions.js';

type OrgSwitcherMenuProps = {
  collapsed: boolean;
  testId?: string;
  /**
   * Called when a link in the panel is followed. The mobile drawer closes on it,
   * the same way its nav links do; the desktop sidebar has nothing to close.
   */
  onNavigate?: () => void;
};

/** One row's worth of chrome, shared by every item and link in the panel. */
const itemClassName =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors data-focus:bg-zinc-100 data-focus:text-zinc-900';

/**
 * The org identity control, pinned at the top of the sidebar, separate from
 * `UserMenu` at the bottom, following the Vercel/Resend pattern of two distinct
 * controls rather than one combined user+org button.
 *
 * The name at the top is the org's identity, and Edit organization is the
 * page about that identity (it also carries the danger zone, gated separately
 * on `org.delete` since Owner and Admin can rename but only Owner can delete).
 * It is gated on `org.rename`, so a role is never offered a page the server
 * would refuse it, and it is past the billing gate, so it stays without an
 * active plan. Members, Billing and Audit log are the sidebar's Organization
 * group. Below a divider the switcher lists the caller's other orgs, and
 * Create organization sits at the foot.
 *
 * Built on Headless UI's `Menu` rather than a hand-rolled popover, matching
 * `RowActionsMenu`'s reasoning: a hand-rolled panel gets Escape and focus
 * return wrong (FIL-990).
 *
 * Always renders, even for a single-org account where `OrgSwitcher` itself
 * renders nothing: "Create organization" is reachable in the organizations beta
 * regardless of how many orgs the caller already has.
 */
export function OrgSwitcherMenu({ collapsed, testId, onNavigate }: OrgSwitcherMenuProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const { has, orgsBeta } = usePermissions();
  const mayEdit = has('org.rename');
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });
  // `switchToOrg` clears the cache, so until the new org's `/me` lands the name
  // comes from the switcher row just clicked.
  const pendingSwitch = usePendingOrgSwitchTarget();
  const orgName = me?.orgName ?? pendingSwitch?.orgName ?? 'Organization';
  const logoUrl = me?.logoUrl ?? pendingSwitch?.logoUrl;

  return (
    <>
      <Menu as="div" className="relative w-full">
        {({ close }) => (
          <>
            <MenuButton
              data-testid={testId}
              aria-label={`Organization menu for ${orgName}`}
              className={[
                'flex items-center rounded-lg hover:bg-zinc-100 focus-visible:brand-outline data-open:bg-zinc-100',
                collapsed ? 'w-full justify-center py-1.5' : 'w-full gap-2 px-2 py-1.5',
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
              className="z-50 mt-1 w-60 rounded-lg border border-zinc-200 bg-white p-1 shadow-md outline-none"
            >
              {mayEdit && (
                <MenuItem
                  as={BaseLink}
                  href="/edit-organization"
                  data-testid="org-menu-edit"
                  onClick={onNavigate}
                  className={itemClassName}
                >
                  <PencilSimpleIcon size={13} className="flex-shrink-0 text-zinc-400" />
                  Edit organization
                </MenuItem>
              )}

              {/* Only when something sits on both sides of it: a role that
                  cannot rename the org has nothing above it, a sole membership
                  outside the beta has no switcher rows and no Create
                  organization below it, and a divider at an edge is a stray
                  line. */}
              {mayEdit && (orgsBeta || (me?.memberships?.length ?? 0) > 1) && (
                <MenuSeparator className="my-1 border-t border-zinc-100" />
              )}
              <OrgSwitcher
                memberships={me?.memberships}
                activeOrgId={me?.orgId}
                onClose={() => {
                  close();
                  onNavigate?.();
                }}
              />
              {orgsBeta && (
                <MenuItem>
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className={itemClassName}
                  >
                    <PlusIcon size={13} className="flex-shrink-0 text-zinc-400" />
                    Create organization
                  </button>
                </MenuItem>
              )}
            </MenuItems>
          </>
        )}
      </Menu>
      <CreateOrganizationDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
