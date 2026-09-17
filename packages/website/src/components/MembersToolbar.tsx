import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr';
import type { OrgRole } from '@filone/shared';

import { Input } from './Input';
import { Select } from './Select';
import { ALL_ROLES, type MemberFilters, hasActiveMemberFilters } from '../lib/member-table.js';
import { ROLE_LABELS } from '../lib/use-member-scope.js';

type MembersToolbarProps = {
  filters: MemberFilters;
  onChange: (filters: MemberFilters) => void;
  /** Roles present in the roster. The filter is hidden below two. */
  roles: OrgRole[];
  /** Rows matching the current filters, for the result count. */
  matchCount: number;
  totalCount: number;
};

/**
 * Filter chrome for the members table. The same shape as `BucketsToolbar`, down
 * to the 32px controls and the count that only appears once the filters narrow
 * something: the two are the console's long lists, and an operator who learned
 * one should not have to learn the other.
 */
export function MembersToolbar({
  filters,
  onChange,
  roles,
  matchCount,
  totalCount,
}: MembersToolbarProps) {
  const showRoleFilter = roles.length > 1;
  const filtering = hasActiveMemberFilters(filters);

  return (
    // Wraps rather than squeezes: at 375px the search takes the full width and
    // the filter and count drop to a second line.
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-400">
          <MagnifyingGlassIcon size={14} />
        </span>
        <Input
          type="search"
          value={filters.query}
          onChange={(query) => onChange({ ...filters, query })}
          placeholder="Search members"
          aria-label="Search members by name, email, or user ID"
          inputSize="sm"
          className="pl-8"
        />
      </div>

      {showRoleFilter && (
        <Select
          value={filters.role}
          onChange={(role) => onChange({ ...filters, role })}
          aria-label="Filter members by role"
          selectSize="sm"
          className="w-auto"
        >
          <option value={ALL_ROLES}>All roles</option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role] ?? role}
            </option>
          ))}
        </Select>
      )}

      {/* Reads as a total until the filters narrow it, then as a fraction, so the
          number always answers "how much am I looking at". */}
      <p className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
        {filtering
          ? `${matchCount} of ${totalCount}`
          : `${totalCount} ${totalCount === 1 ? 'member' : 'members'}`}
      </p>
    </div>
  );
}
