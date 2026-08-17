import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { OrgMembershipSummary } from '@filone/shared';

import { switchToOrg } from '../lib/active-org.js';

type OrgSwitcherProps = {
  /** Every org the caller belongs to, as `/me` reported them. */
  memberships: OrgMembershipSummary[] | undefined;
  /** The org the server resolved this session in — the one to mark as current. */
  activeOrgId: string | undefined;
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
 * second membership exists, and switching reloads the tab — no query key carries
 * an org dimension, so a reload is what keeps one org's cache out of the other's
 * view.
 *
 * Rendered from `/me`'s `memberships` rather than a list of its own, so the
 * options and the role the server enforces come from the same response and
 * cannot disagree.
 */
export function OrgSwitcher({ memberships, activeOrgId, testId }: OrgSwitcherProps) {
  if (!memberships || memberships.length <= 1) return null;

  return (
    <div
      {...(testId ? { 'data-testid': testId } : {})}
      role="group"
      aria-label="Organization"
      className="border-b border-zinc-100 pb-1"
    >
      <p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Organization
      </p>
      {memberships.map((membership) => {
        const isActive = membership.orgId === activeOrgId;
        return (
          <button
            key={membership.orgId}
            type="button"
            aria-current={isActive || undefined}
            // Switching to the org already in use would reload the tab to
            // arrive exactly where it is.
            onClick={isActive ? undefined : () => switchToOrg(membership.orgId)}
            className={[
              'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
              isActive ? 'text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100',
            ].join(' ')}
          >
            <span className="min-w-0 flex-1 truncate">
              {membership.orgName || 'Untitled organization'}
            </span>
            {isActive && <CheckIcon size={14} className="flex-shrink-0 text-brand-600" />}
          </button>
        );
      })}
    </div>
  );
}
