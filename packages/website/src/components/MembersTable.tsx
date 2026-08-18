import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { RoleSelect } from './RoleSelect';
import { Table } from './Table/Table';
import { formatDate } from '../lib/time.js';
import { ROLE_LABELS, ROLES_BY_AUTHORITY } from '../lib/use-member-scope.js';

/**
 * How a member is named when the profile row has learned nothing about them.
 *
 * A user's display identity lives in Auth0; the row we hold carries their id,
 * their org, and when they joined. So `name` and `email` are usually absent
 * today, and the id is the only thing that is always true. It goes on every row
 * as the second line — it is also what an operator quotes to support — and the
 * first line falls back to it rather than inventing a placeholder person.
 */
function memberName(member: MemberSummary): string {
  return member.name || member.email || 'Unnamed member';
}

function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <Badge color={role === OrgRole.Owner ? 'blue' : 'grey'} size="sm" weight="medium">
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}

/** Where a member came from, when the row says. */
const SOURCE_LABELS: Record<string, string> = {
  signup: 'Signed up',
  conversion: 'Original account',
  invitation: 'Invited',
};

export type MembersTableProps = {
  members: MemberSummary[];
  /** The caller, so their own row says so and does not offer a transfer to self. */
  currentUserId?: string;
  /** Whether the caller may move a member from one role to another. */
  mayChangeRole: (fromRole: string, toRole: string) => boolean;
  /** Whether the caller may remove a member holding this role. */
  mayManageTarget: (targetRole: string) => boolean;
  /** Whether the caller holds `org.transfer`. */
  mayTransfer?: boolean;
  onChangeRole?: (member: MemberSummary, role: OrgRole) => void;
  onRemove?: (member: MemberSummary) => void;
  onTransfer?: (member: MemberSummary) => void;
  /** The member a mutation is in flight for — that row's controls go inert. */
  pendingUserId?: string;
};

/**
 * The org's roster, and the verbs the caller's role reaches on each row.
 *
 * Presentational, like `AccessKeysTable`: the page owns the queries and the
 * confirmations, and this decides only what a row offers. The ceiling is asked
 * per row rather than per table, because it depends on the target — an Admin
 * manages Admins and below and cannot touch an Owner at all, so the same caller
 * sees a role picker on one row and a plain badge on the next.
 */
export function MembersTable({
  members,
  currentUserId,
  mayChangeRole,
  mayManageTarget,
  mayTransfer = false,
  onChangeRole,
  onRemove,
  onTransfer,
  pendingUserId,
}: MembersTableProps) {
  // The roles this caller could move this member into, current role included —
  // exactly the set the server would accept for them. One entry means the role
  // is fixed for this caller, and a select of one is not a choice.
  const rolesFor = (member: MemberSummary) =>
    ROLES_BY_AUTHORITY.filter((role) => mayChangeRole(member.role, role));

  const canRemove = (member: MemberSummary) => Boolean(onRemove) && mayManageTarget(member.role);
  const canTransferTo = (member: MemberSummary) =>
    Boolean(onTransfer) &&
    mayTransfer &&
    member.role !== OrgRole.Owner &&
    member.userId !== currentUserId;

  // The header follows the cells: a column whose every row is empty is a column
  // of whitespace with a screen-reader label attached to nothing.
  const showActions = members.some((m) => canRemove(m) || canTransferTo(m));

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Member</Table.Head>
          <Table.Head>Role</Table.Head>
          <Table.Head className="hidden md:table-cell">Joined</Table.Head>
          {showActions && (
            <Table.Head>
              <span className="sr-only">Actions</span>
            </Table.Head>
          )}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {members.map((member) => {
          const name = memberName(member);
          const roles = rolesFor(member);
          const pending = pendingUserId === member.userId;

          return (
            <Table.Row
              key={member.userId}
              data-testid="member-row"
              data-member-id={member.userId}
              data-member-role={member.role}
            >
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-zinc-900">{name}</p>
                  {member.userId === currentUserId && (
                    <Badge color="grey" size="sm" weight="regular">
                      You
                    </Badge>
                  )}
                </div>
                <p className="font-mono text-xs text-zinc-500">{member.userId}</p>
              </Table.Cell>

              <Table.Cell>
                {onChangeRole && roles.length > 1 ? (
                  <RoleSelect
                    value={member.role}
                    roles={roles}
                    disabled={pending}
                    aria-label={`Role for ${name}`}
                    onChange={(role) => onChangeRole(member, role)}
                  />
                ) : (
                  <RoleBadge role={member.role} />
                )}
              </Table.Cell>

              <Table.Cell className="hidden md:table-cell text-xs text-zinc-500">
                {member.joinedAt ? formatDate(member.joinedAt) : '—'}
                {member.source && SOURCE_LABELS[member.source] && (
                  <span className="block text-zinc-400">{SOURCE_LABELS[member.source]}</span>
                )}
              </Table.Cell>

              {showActions && (
                <Table.Cell className="text-right">
                  <div className="flex justify-end gap-1">
                    {canTransferTo(member) && onTransfer && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={`Transfer ownership to ${name}`}
                        onClick={() => onTransfer(member)}
                      >
                        Transfer ownership
                      </Button>
                    )}
                    {canRemove(member) && onRemove && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={`Remove ${name}`}
                        onClick={() => onRemove(member)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </Table.Cell>
              )}
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  );
}
