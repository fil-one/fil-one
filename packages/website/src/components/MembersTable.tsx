import { TrashIcon, UserSwitchIcon } from '@phosphor-icons/react/dist/ssr';
import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { Badge } from './Badge';
import { RoleSelect } from './RoleSelect';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';
import { Table } from './Table/Table';
import { formatDate } from '../lib/time.js';
import {
  canTransferTo,
  memberName,
  ROLE_LABELS,
  ROLES_BY_AUTHORITY,
} from '../lib/use-member-scope.js';

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
  /**
   * The members a mutation is in flight for — those rows' controls go inert. A
   * set rather than one id, so a second row going busy does not bring the first
   * one back.
   */
  pendingUserIds?: ReadonlySet<string>;
};

const NONE_PENDING: ReadonlySet<string> = new Set();

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
  pendingUserIds = NONE_PENDING,
}: MembersTableProps) {
  // The roles this caller could move this member into, current role included —
  // exactly the set the server would accept for them. One entry means the role
  // is fixed for this caller, and a select of one is not a choice.
  const rolesFor = (member: MemberSummary) =>
    ROLES_BY_AUTHORITY.filter((role) => mayChangeRole(member.role, role));

  const canRemove = (member: MemberSummary) => Boolean(onRemove) && mayManageTarget(member.role);
  const offersTransfer = (member: MemberSummary) =>
    Boolean(onTransfer) && canTransferTo(member, { mayTransfer, currentUserId });

  // The header follows the cells: a column whose every row is empty is a column
  // of whitespace with a screen-reader label attached to nothing.
  const showActions = members.some((m) => canRemove(m) || offersTransfer(m));

  /** The verbs this caller's role reaches on this row, least destructive first. */
  const actionsFor = (member: MemberSummary): RowAction[] => {
    const actions: RowAction[] = [];
    if (offersTransfer(member) && onTransfer) {
      actions.push({
        label: 'Transfer ownership',
        icon: UserSwitchIcon,
        testId: 'member-action-transfer-ownership',
        onSelect: () => onTransfer(member),
      });
    }
    if (canRemove(member) && onRemove) {
      actions.push({
        // Not "Remove member": the confirmation that follows uses that as its
        // confirm label, and two controls with one name is a coin toss for
        // anybody selecting by name, tests included.
        label: 'Remove',
        icon: TrashIcon,
        destructive: true,
        testId: 'member-action-remove',
        onSelect: () => onRemove(member),
      });
    }
    return actions;
  };

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
          const pending = pendingUserIds.has(member.userId);

          return (
            <Table.Row
              key={member.userId}
              data-testid="member-row"
              data-member-id={member.userId}
              data-member-role={member.role}
              aria-busy={pending || undefined}
            >
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900">{name}</p>
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
                  // Left enabled while its own change is in flight, and the
                  // change ignored instead. Disabling the control somebody just
                  // used drops focus to the document body, and nothing puts it
                  // back — so a keyboard caller loses their place on the row
                  // they are working. `aria-busy` on the row says what the
                  // disabled attribute used to.
                  // Sized to the longest label ("Read only") rather than
                  // filling the column: a picker of four short words reads as a
                  // mistake when it is wider than every value it can hold. The
                  // width goes on a wrapper because `Select` is `w-full`, which
                  // Tailwind orders after `w-32` and would win.
                  <div className="w-32">
                    <RoleSelect
                      value={member.role}
                      roles={roles}
                      size="sm"
                      aria-label={`Role for ${name}`}
                      onChange={(role) => {
                        if (!pending) onChangeRole(member, role);
                      }}
                    />
                  </div>
                ) : (
                  <RoleBadge role={member.role} />
                )}
              </Table.Cell>

              {/* The date is the value and the source is its caption, so they
                  take the same two-tone split as the member cell beside them —
                  at one step apart they read as two competing facts. */}
              <Table.Cell className="hidden md:table-cell text-xs text-zinc-700">
                {member.joinedAt ? formatDate(member.joinedAt) : '—'}
                {member.source && SOURCE_LABELS[member.source] && (
                  <span className="block text-zinc-500">{SOURCE_LABELS[member.source]}</span>
                )}
              </Table.Cell>

              {showActions && (
                <Table.Cell className="text-right">
                  {/* Both verbs behind one control rather than spelled out per
                      row: "Transfer ownership" and "Remove" repeated down the
                      table read as noise, and a destructive action one misclick
                      from the role picker is worth a deliberate second click. */}
                  <div className="flex justify-end">
                    <RowActionsMenu
                      aria-label={`Actions for ${name}`}
                      disabled={pending}
                      actions={actionsFor(member)}
                    />
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
