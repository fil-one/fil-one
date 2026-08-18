import type { Meta, StoryObj } from '@storybook/react-vite';
import { canManageTargetRole, OrgRole } from '@filone/shared';
import type { InvitationSummary } from '@filone/shared';

import { InvitationsTable } from './InvitationsTable';

function invitation(over: Partial<InvitationSummary> = {}): InvitationSummary {
  return {
    inviteId: 'inv-1',
    email: 'teammate@example.com',
    role: OrgRole.Member,
    invitedBy: 'user-1',
    createdAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-08-15T00:00:00Z',
    status: 'pending',
    expired: false,
    ...over,
  };
}

const invitations: InvitationSummary[] = [
  invitation({ inviteId: 'inv-1', email: 'waiting@example.com' }),
  invitation({ inviteId: 'inv-2', email: 'admin@example.com', role: OrgRole.Admin }),
  invitation({
    inviteId: 'inv-3',
    email: 'stale@example.com',
    expired: true,
    expiresAt: '2026-07-01T00:00:00Z',
  }),
  invitation({ inviteId: 'inv-4', email: 'unsent@example.com', lastSendFailed: true }),
];

const meta: Meta<typeof InvitationsTable> = {
  title: 'Components/InvitationsTable',
  component: InvitationsTable,
  args: {
    invitations,
    mayManageTarget: (target: string) => canManageTargetRole(OrgRole.Owner, target),
    onRevoke: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof InvitationsTable>;

/**
 * The three states a pending invitation can be in. Expired and undelivered are
 * both live rows nobody can act on, for different reasons, and the remedy for
 * either is to invite the address again.
 */
export const Default: Story = {};

/** An Owner invitation is only revocable by somebody holding `owners.manage`. */
export const WithOwnerInvitation: Story = {
  args: {
    invitations: [
      invitation({ inviteId: 'inv-5', email: 'boss@example.com', role: OrgRole.Owner }),
      ...invitations,
    ],
    mayManageTarget: (target: string) => canManageTargetRole(OrgRole.Admin, target),
  },
};

/** Two revokes in flight at once — each row says so on its own account. */
export const Revoking: Story = {
  args: { pendingInviteIds: new Set(['inv-1', 'inv-2']) },
};

/** Nothing to revoke: the actions column goes with the last row that had one. */
export const ReadOnlyView: Story = {
  args: { onRevoke: undefined },
};
