import { describe, it, expect } from 'vitest';
import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import {
  ALL_ROLES,
  EMPTY_MEMBER_FILTERS,
  filterMembers,
  hasActiveMemberFilters,
  memberRoles,
  shouldShowMemberControls,
} from './member-table.js';

function member(overrides: Partial<MemberSummary> = {}): MemberSummary {
  return { userId: 'auth0|1', role: OrgRole.Member, ...overrides };
}

describe('shouldShowMemberControls', () => {
  it('holds the controls back until the roster is worth searching', () => {
    expect(shouldShowMemberControls(4)).toBe(false);
    expect(shouldShowMemberControls(5)).toBe(true);
  });
});

describe('hasActiveMemberFilters', () => {
  it('is false for the empty filters and for whitespace alone', () => {
    expect(hasActiveMemberFilters(EMPTY_MEMBER_FILTERS)).toBe(false);
    expect(hasActiveMemberFilters({ query: '   ', role: ALL_ROLES })).toBe(false);
  });

  it('is true once either filter narrows the roster', () => {
    expect(hasActiveMemberFilters({ query: 'ada', role: ALL_ROLES })).toBe(true);
    expect(hasActiveMemberFilters({ query: '', role: OrgRole.Admin })).toBe(true);
  });
});

describe('filterMembers', () => {
  const roster = [
    member({ userId: 'auth0|1', name: 'Ada Lovelace', email: 'ada@example.com' }),
    member({ userId: 'auth0|2', email: 'grace@example.com', role: OrgRole.Admin }),
    member({ userId: 'auth0|deadbeef', role: OrgRole.ReadOnly }),
  ];

  it('returns the whole roster when nothing is filtered', () => {
    expect(filterMembers(roster, EMPTY_MEMBER_FILTERS)).toEqual(roster);
  });

  it('matches the name, the email, and the user id, case-insensitively', () => {
    const ids = (query: string) =>
      filterMembers(roster, { query, role: ALL_ROLES }).map((m) => m.userId);

    expect(ids('lovelace')).toEqual(['auth0|1']);
    expect(ids('GRACE@')).toEqual(['auth0|2']);
    // The row with neither a name nor an email is still reachable.
    expect(ids('deadbeef')).toEqual(['auth0|deadbeef']);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterMembers(roster, { query: '  ada  ', role: ALL_ROLES })).toHaveLength(1);
  });

  it('keeps only the chosen role, and combines with the query', () => {
    expect(filterMembers(roster, { query: '', role: OrgRole.Admin })).toEqual([roster[1]]);
    expect(filterMembers(roster, { query: 'ada', role: OrgRole.Admin })).toEqual([]);
  });
});

describe('memberRoles', () => {
  it('lists the roles present, most authority first', () => {
    const roster = [
      member({ role: OrgRole.Member }),
      member({ role: OrgRole.Owner }),
      member({ role: OrgRole.Member }),
      member({ role: OrgRole.ReadOnly }),
    ];
    expect(memberRoles(roster)).toEqual([OrgRole.Owner, OrgRole.Member, OrgRole.ReadOnly]);
  });

  it('returns one entry for a single-role roster, so the filter stays hidden', () => {
    expect(memberRoles([member(), member()])).toEqual([OrgRole.Member]);
  });

  it('returns nothing for an empty roster', () => {
    expect(memberRoles([])).toEqual([]);
  });
});
