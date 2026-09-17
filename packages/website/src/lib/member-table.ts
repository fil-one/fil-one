// Members-table filter state and helpers, the counterpart to `bucket-table.ts`.
//
// Filtering happens here rather than on the server, which is the one place this
// deliberately parts from the buckets table: `list-members` returns the whole
// roster in one response and an org's roster is bounded by the people in it, so
// there is nothing to save by asking again on every keystroke.

import type { MemberSummary, OrgRole } from '@filone/shared';

import { ROLES_BY_AUTHORITY } from './use-member-scope.js';

/**
 * Roster size at which the table starts showing its search and role filter.
 * Below this the whole list is one glance and the controls are chrome. The same
 * threshold the buckets table uses, so the two surfaces reveal at once.
 */
export const MEMBER_TABLE_CONTROLS_MIN = 5;

/** True when a roster is long enough to be worth searching and filtering. */
export function shouldShowMemberControls(memberCount: number): boolean {
  return memberCount >= MEMBER_TABLE_CONTROLS_MIN;
}

export type MemberFilters = {
  /** Free-text match against the name, email, and user id. */
  query: string;
  /** Role to keep, or 'all' for every role. */
  role: string;
};

export const ALL_ROLES = 'all';

export const EMPTY_MEMBER_FILTERS: MemberFilters = { query: '', role: ALL_ROLES };

/**
 * True when the filters actually narrow the roster. Drives the result count,
 * which says nothing while every member is showing.
 */
export function hasActiveMemberFilters(filters: MemberFilters): boolean {
  return filters.query.trim() !== '' || filters.role !== ALL_ROLES;
}

/**
 * The roster narrowed to the current filters.
 *
 * The user id is searchable alongside the name and email because it is often the
 * only thing a row has: a display identity lives in Auth0 and `name` and `email`
 * are usually absent, so a search that read those two alone would come back
 * empty on exactly the rosters that most need searching. It is also what an
 * operator has in hand, having copied it out of a row to quote to support.
 */
export function filterMembers(members: MemberSummary[], filters: MemberFilters): MemberSummary[] {
  const query = filters.query.trim().toLowerCase();

  return members.filter((member) => {
    if (filters.role !== ALL_ROLES && member.role !== filters.role) return false;
    if (query === '') return true;
    return [member.name, member.email, member.userId].some((field) =>
      field?.toLowerCase().includes(query),
    );
  });
}

/**
 * Roles present in `members`, most authority first, so the filter offers only
 * choices that would return a row. Worth showing at more than one.
 */
export function memberRoles(members: MemberSummary[]): OrgRole[] {
  const present = new Set<string>(members.map((member) => member.role));
  return ROLES_BY_AUTHORITY.filter((role) => present.has(role));
}
