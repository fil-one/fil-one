import { useQuery } from '@tanstack/react-query';
import { SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyStatement } from '@filone/shared';
import { POLICY_WILDCARD_PRINCIPAL } from '@filone/shared';

import { listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { memberName, roleLabel } from '../lib/use-member-scope.js';
import { Checkbox } from './Checkbox.js';
import { Icon } from './Icon.js';
import { RadioOption } from './RadioOption.js';

export type PolicyPrincipalFieldsProps = {
  value: PolicyStatement['Principal'];
  onChange: (value: PolicyStatement['Principal']) => void;
};

/**
 * Who a statement applies to: everyone in the organization, or members picked
 * from the organization's member list.
 *
 * A selected id the member list no longer has stays as an unknown member, so
 * editing a statement cannot silently drop someone from it.
 */
export function PolicyPrincipalFields({ value, onChange }: PolicyPrincipalFieldsProps) {
  const isEveryoneSelected = value === POLICY_WILDCARD_PRINCIPAL;
  const selectedIds = isEveryoneSelected ? [] : value;
  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.members,
    queryFn: listMembers,
    enabled: !isEveryoneSelected,
  });
  const members = data?.members ?? [];
  const unknownMemberIds = selectedIds.filter((id) => !members.some((m) => m.userId === id));
  const isLoadingMembers = !isEveryoneSelected && isPending;

  function toggle(userId: string) {
    onChange(
      selectedIds.includes(userId)
        ? selectedIds.filter((id) => id !== userId)
        : [...selectedIds, userId],
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <RadioOption
          name="policy-principal"
          value="everyone"
          checked={isEveryoneSelected}
          onChange={() => onChange(POLICY_WILDCARD_PRINCIPAL)}
        >
          Everyone in this organization
        </RadioOption>
        <RadioOption
          name="policy-principal"
          value="specific"
          checked={!isEveryoneSelected}
          onChange={() => onChange([])}
        >
          Specific members
        </RadioOption>
      </div>

      {!isEveryoneSelected && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
          {isLoadingMembers && (
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
          {!isLoadingMembers &&
            !isError &&
            members.length === 0 &&
            unknownMemberIds.length === 0 && (
              <p className="text-sm text-zinc-500">No members found.</p>
            )}
          {!isLoadingMembers && (members.length > 0 || unknownMemberIds.length > 0) && (
            <div className="flex flex-col gap-1.5">
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  label={memberName(member)}
                  detail={roleLabel(member.role)}
                  checked={selectedIds.includes(member.userId)}
                  onChange={() => toggle(member.userId)}
                />
              ))}
              {unknownMemberIds.map((userId) => (
                <MemberRow
                  key={userId}
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
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    // Same shape as CheckboxRow: the row toggles, the checkbox's click stays its own.
    <div className="flex cursor-pointer items-center gap-2.5 py-1" onClick={onChange}>
      <Checkbox
        aria-label={label}
        checked={checked}
        onChange={onChange}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="text-xs text-zinc-900">{label}</span>
      <span className="text-meta text-zinc-500">{detail}</span>
    </div>
  );
}
