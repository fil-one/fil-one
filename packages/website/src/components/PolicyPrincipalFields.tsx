import { useQuery } from '@tanstack/react-query';
import { SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import type { MemberSummary, PolicyStatement } from '@filone/shared';
import { POLICY_WILDCARD_PRINCIPAL } from '@filone/shared';

import { listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { memberName, roleLabel } from '../lib/use-member-scope.js';
import { Checkbox } from './Checkbox.js';
import { Icon } from './Icon.js';
import { RadioOption } from './RadioOption.js';

export type PolicyPrincipalFieldsProps = {
  value: PolicyStatement['principal'];
  onChange: (value: PolicyStatement['principal']) => void;
};

/**
 * Who a statement applies to: everyone in the organization, or members picked
 * from the roster. The same shape as the key form's bucket scope: a radio pair,
 * then a checklist when the specific option is chosen.
 *
 * A selected id the roster no longer lists stays in the list as an unknown
 * member, so editing a statement cannot silently drop someone from it.
 */
export function PolicyPrincipalFields({ value, onChange }: PolicyPrincipalFieldsProps) {
  const everyone = value === POLICY_WILDCARD_PRINCIPAL;
  const selected = everyone ? [] : value;
  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.members,
    queryFn: listMembers,
    enabled: !everyone,
  });
  const members = data?.members ?? [];
  const unknown = selected.filter((id) => !members.some((m) => m.userId === id));
  const loading = !everyone && isPending;

  function toggle(userId: string) {
    onChange(
      selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId],
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <RadioOption
          name="policy-principal"
          value="everyone"
          testId="policy-principal-everyone"
          checked={everyone}
          onChange={() => onChange(POLICY_WILDCARD_PRINCIPAL)}
        >
          Everyone in this organization
        </RadioOption>
        <RadioOption
          name="policy-principal"
          value="specific"
          testId="policy-principal-specific"
          checked={!everyone}
          onChange={() => onChange([])}
        >
          Specific members
        </RadioOption>
      </div>

      {!everyone && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
          {loading && (
            <div className="flex items-center justify-center py-4" role="status">
              <span className="animate-spin text-brand-700">
                <Icon component={SpinnerIcon} size={20} />
              </span>
              <span className="sr-only">Loading members</span>
            </div>
          )}
          {isError && (
            <p className="text-sm text-red-600">{error?.message ?? 'Failed to load members'}</p>
          )}
          {!loading && !isError && members.length === 0 && unknown.length === 0 && (
            <p className="text-sm text-zinc-500">No members found.</p>
          )}
          {!loading && (members.length > 0 || unknown.length > 0) && (
            <div className="flex flex-col gap-1.5">
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  userId={member.userId}
                  label={memberName(member)}
                  detail={roleLabel(member.role)}
                  checked={selected.includes(member.userId)}
                  onChange={() => toggle(member.userId)}
                />
              ))}
              {unknown.map((userId) => (
                <MemberRow
                  key={userId}
                  userId={userId}
                  label="Unknown member"
                  detail={userId}
                  checked
                  onChange={() => toggle(userId)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MemberRow({
  userId,
  label,
  detail,
  checked,
  onChange,
}: {
  userId: string;
  label: string;
  detail: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1">
      <Checkbox
        aria-label={label}
        data-testid="policy-principal-member"
        data-user-id={userId}
        checked={checked}
        onChange={onChange}
      />
      <span className="text-xs text-zinc-900">{label}</span>
      <span className="text-meta text-zinc-500">{detail}</span>
    </label>
  );
}

/** Members by id, for the card's names. Exported so the tab reads the roster once. */
export function memberNamesFrom(members: readonly MemberSummary[] | undefined) {
  return (userId: string): string | undefined => {
    const member = members?.find((m) => m.userId === userId);
    return member ? memberName(member) : undefined;
  };
}
