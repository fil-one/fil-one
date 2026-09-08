import { useEffect, useState } from 'react';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { OrgMembershipSummary } from '@filone/shared';

import { OrgAvatar } from './OrgAvatar';
import { Overline } from './Overline';
import { onSwitchingOrgChange, switchToOrg } from '../lib/active-org.js';

type OrgSwitcherProps = {
  /** Every org the caller belongs to, as `/me` reported them. */
  memberships: OrgMembershipSummary[] | undefined;
  /** The org the server resolved this session in — the one to mark as current. */
  activeOrgId: string | undefined;
  /**
   * Mounted inside a `role="menu"` panel, whose children have to be menu items.
   * The desktop dropdown is a plain panel and takes the default.
   */
  inMenu?: boolean;
  /**
   * e2e identifier for this copy of the switcher. The desktop sidebar and the
   * mobile user menu both mount one, so the selector has to be theirs rather
   * than the component's, exactly as `SidebarNav`'s `showTestIds` arranges.
   */
  testId?: string;
};

/**
 * Which organization this tab is operating in, and how to change it.
 *
 * Absent for a caller with one membership, which is every account today: an org
 * surface that shows a solo user a list of one is noise. It appears the moment a
 * second membership exists, and switching loads the console's root — no query key
 * carries an org dimension, so a fresh load is what keeps one org's cache out of
 * the other's view.
 *
 * Rendered from `/me`'s `memberships` rather than a list of its own, so the
 * options and the role the server enforces come from the same response and
 * cannot disagree.
 */
export function OrgSwitcher({ memberships, activeOrgId, inMenu, testId }: OrgSwitcherProps) {
  // The click starts a page load, and the browser takes its time about it. Until
  // it lands the list is inert: a second click would stash a third org while the
  // load for the second is already in flight.
  const [chosen, setChosen] = useState<string | null>(null);

  // A navigation can be cancelled — the upload page asks before it leaves — and
  // the tab then rolls the switch back. The rows come with it, or the user is
  // left looking at a list that no longer responds.
  useEffect(() => onSwitchingOrgChange((switching) => !switching && setChosen(null)), []);

  if (!memberships || memberships.length <= 1) return null;

  // By name, because the caller reads names. The server returns them in key
  // order, which is org id order — arbitrary to everyone but the database.
  const ordered = [...memberships].sort((a, b) => (a.orgName || '').localeCompare(b.orgName || ''));

  return (
    <div
      {...(testId ? { 'data-testid': testId } : {})}
      role="group"
      aria-label="Organization"
      // The backend answers up to 100 memberships and neither dropdown scrolls,
      // so the list is what scrolls.
      // `pb-1 mb-1`: the rule is this component's trailing edge, so the space
      // on both sides of it belongs here rather than to whatever follows.
      className="max-h-64 overflow-y-auto border-b border-zinc-100 pb-1 mb-1"
    >
      {/* The shared overline rather than another hand-rolled uppercase label:
          `SidebarNav`'s own section headings still inline theirs, which is the
          kind of duplication FIL-1032 is about. */}
      <Overline className="mt-1 mb-1 px-3">Organization</Overline>
      {ordered.map((membership) => {
        const isActive = membership.orgId === activeOrgId;
        const isInert = isActive || chosen !== null;
        return (
          <button
            key={membership.orgId}
            type="button"
            // Inside a menu the current org is the checked radio; outside one
            // there is no menu semantic to satisfy and `aria-current` says it.
            {...(inMenu
              ? { role: 'menuitemradio', 'aria-checked': isActive }
              : { 'aria-current': isActive || undefined })}
            // Not `disabled`: a disabled button leaves the keyboard, and the
            // current org is a state worth reaching and reading.
            aria-disabled={isInert || undefined}
            aria-busy={chosen === membership.orgId || undefined}
            // Switching to the org already in use would load the console to
            // arrive exactly where it is.
            onClick={
              isInert
                ? undefined
                : () => {
                    setChosen(membership.orgId);
                    switchToOrg(membership.orgId, undefined, 'dashboard', {
                      orgName: membership.orgName,
                      logoUrl: membership.logoUrl,
                    });
                  }
            }
            className={[
              // `py-1.5` and `rounded-lg` to match `Log out`, the row directly
              // below it in the same menu.
              'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors',
              'focus-visible:brand-outline',
              isActive ? 'font-medium text-zinc-900' : 'text-zinc-600',
              isInert ? '' : 'hover:bg-zinc-100 hover:text-zinc-900',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <OrgAvatar
              name={membership.orgName || 'Untitled organization'}
              logoUrl={membership.logoUrl}
              size="xs"
            />
            <span className="min-w-0 flex-1 truncate">
              {membership.orgName || 'Untitled organization'}
            </span>
            {isActive && <CheckIcon size={13} weight="bold" className="shrink-0 text-brand-600" />}
          </button>
        );
      })}
    </div>
  );
}
