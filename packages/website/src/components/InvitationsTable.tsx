import { OrgRole } from '@filone/shared';
import type { InvitationSummary } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { Table } from './Table/Table';
import { formatDate } from '../lib/time.js';
import { ROLE_LABELS } from '../lib/use-member-scope.js';

/**
 * What is wrong with an invitation, when something is.
 *
 * Both states are live rows that nobody can act on for different reasons, and
 * the remedy is the same — invite the address again, which replaces the row —
 * so they are told apart rather than collapsed into "pending". `expired` is
 * computed by the server from `expiresAt`, so the two halves of the product
 * cannot disagree about whether a link still works.
 */
function InvitationStatus({ invitation }: { invitation: InvitationSummary }) {
  if (invitation.expired) {
    return (
      <Badge color="grey" size="sm" data-testid="invitation-expired">
        Expired
      </Badge>
    );
  }
  if (invitation.lastSendFailed) {
    return (
      <Badge color="amber" size="sm" dot data-testid="invitation-undelivered">
        Not delivered
      </Badge>
    );
  }
  return (
    <Badge color="blue" size="sm" dot>
      Waiting
    </Badge>
  );
}

export type InvitationsTableProps = {
  invitations: InvitationSummary[];
  /** Whether the caller may revoke an invitation for this role. */
  mayManageTarget: (targetRole: string) => boolean;
  onRevoke?: (invitation: InvitationSummary) => void;
  /**
   * The invitations a revoke is in flight for. A set rather than one id, so a
   * second revoke does not re-arm the button on the first.
   */
  pendingInviteIds?: ReadonlySet<string>;
};

const NONE_PENDING: ReadonlySet<string> = new Set();

/**
 * Every invitation this org is still waiting on.
 *
 * Only pending rows arrive here — accepted and revoked invitations leave the
 * list — so the question each row answers is why nobody has joined yet.
 */
export function InvitationsTable({
  invitations,
  mayManageTarget,
  onRevoke,
  pendingInviteIds = NONE_PENDING,
}: InvitationsTableProps) {
  const canRevoke = (invitation: InvitationSummary) =>
    Boolean(onRevoke) && mayManageTarget(invitation.role);
  const showActions = invitations.some(canRevoke);

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Email</Table.Head>
          <Table.Head>Role</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head className="hidden md:table-cell">Expires</Table.Head>
          {showActions && (
            <Table.Head>
              <span className="sr-only">Actions</span>
            </Table.Head>
          )}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {invitations.map((invitation) => (
          <Table.Row
            key={invitation.inviteId}
            data-testid="invitation-row"
            data-invite-id={invitation.inviteId}
            aria-busy={pendingInviteIds.has(invitation.inviteId) || undefined}
          >
            <Table.Cell>
              <p className="text-xs font-medium text-zinc-900">{invitation.email}</p>
              <p className="text-xs text-zinc-500">Invited {formatDate(invitation.createdAt)}</p>
            </Table.Cell>

            <Table.Cell>
              <Badge color={invitation.role === OrgRole.Owner ? 'blue' : 'grey'} size="sm">
                {ROLE_LABELS[invitation.role] ?? invitation.role}
              </Badge>
            </Table.Cell>

            <Table.Cell>
              <InvitationStatus invitation={invitation} />
            </Table.Cell>

            <Table.Cell className="hidden md:table-cell text-xs text-zinc-500">
              {formatDate(invitation.expiresAt)}
            </Table.Cell>

            {showActions && (
              <Table.Cell className="text-right">
                {canRevoke(invitation) && onRevoke && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pendingInviteIds.has(invitation.inviteId)}
                    aria-label={`Revoke invitation for ${invitation.email}`}
                    onClick={() => onRevoke(invitation)}
                  >
                    Revoke
                  </Button>
                )}
              </Table.Cell>
            )}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}
