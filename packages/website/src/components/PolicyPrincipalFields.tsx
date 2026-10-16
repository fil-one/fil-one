import { useQuery } from '@tanstack/react-query';
import { SpinnerIcon, UsersThreeIcon } from '@phosphor-icons/react/dist/ssr';
import { POLICY_WILDCARD_PRINCIPAL } from '@filone/shared';

import { listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { memberName, roleLabel } from '../lib/use-member-scope.js';
import { Checkbox } from './Checkbox.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { StateCard } from './StateCard.js';
import { Icon } from './Icon.js';
import { RadioOption } from './RadioOption.js';

/** Who a statement applies to, as the editor holds it: everyone, or member ids. */
export type PrincipalSelection = '*' | string[];

export type PolicyPrincipalFieldsProps = {
  value: PrincipalSelection;
  onChange: (value: PrincipalSelection) => void;
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
  const { data, isPending, isError } = useQuery({
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
          testId="policy-principal-everyone"
          checked={isEveryoneSelected}
          onChange={() => onChange(POLICY_WILDCARD_PRINCIPAL)}
        >
          Everyone in this organization
        </RadioOption>
        <RadioOption
          name="policy-principal"
          value="specific"
          testId="policy-principal-specific"
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
            <StateCard border="dashed">
              <p className="text-sm text-zinc-700">The member list could not be loaded.</p>
              <p className="text-meta text-zinc-500">Reload the page and try again.</p>
            </StateCard>
          )}
          {!isLoadingMembers &&
            !isError &&
            members.length === 0 &&
            unknownMemberIds.length === 0 && (
              <EmptyStateCard
                icon={UsersThreeIcon}
                title="No members yet"
                description="Invite people to the organization to name them in a statement."
                bordered={false}
              />
            )}
          {!isLoadingMembers && !isError && (members.length > 0 || unknownMemberIds.length > 0) && (
            <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  userId={member.userId}
                  label={memberName(member)}
                  detail={roleLabel(member.role)}
                  checked={selectedIds.includes(member.userId)}
                  onChange={() => toggle(member.userId)}
                />
              ))}
              {unknownMemberIds.map((userId) => (
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
    // Same shape as CheckboxRow: the row toggles, the checkbox's click stays its own.
    <div className="flex cursor-pointer items-center gap-2.5 py-1" onClick={onChange}>
      <Checkbox
        aria-label={label}
        data-testid="policy-principal-member"
        data-user-id={userId}
        checked={checked}
        onChange={onChange}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="text-xs text-zinc-900">{label}</span>
      <span className="text-meta text-zinc-500">{detail}</span>
    </div>
  );
}
