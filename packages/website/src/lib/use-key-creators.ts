import { useQuery } from '@tanstack/react-query';

import { listMembers } from './members-api.js';
import { queryKeys } from './query-client.js';
import { memberName } from './use-member-scope.js';

/** How a key's minter is named where a person reads it. */
export interface KeyCreator {
  name: string;
  email?: string;
}

/**
 * Resolve the member who minted a key, for orgs with somebody else in them.
 *
 * `undefined` for a solo org, which is what leaves the column off: a column
 * reading the same name on every row is noise. It matters at all because
 * removing a member does not revoke their keys (FIL-1021), so this is the
 * column that says which keys leave with them.
 *
 * `members.read` is held by every role, so the read asks nothing the caller
 * cannot have, and a failed one simply resolves to `undefined`.
 *
 * @param enabled whether the caller can see keys at all — no point reading the
 * roster to annotate a table that is not being rendered.
 */
export function useKeyCreators(
  enabled: boolean,
): ((userId: string) => KeyCreator | undefined) | undefined {
  const { data } = useQuery({ queryKey: queryKeys.members, queryFn: listMembers, enabled });

  const members = data?.members ?? [];
  if (members.length <= 1) return undefined;

  return (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    if (!member) return undefined;
    return { name: memberName(member), ...(member.email ? { email: member.email } : {}) };
  };
}
