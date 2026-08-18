import type { Meta, StoryObj } from '@storybook/react-vite';
import { canChangeRole, canManageTargetRole, OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { MembersTable } from './MembersTable';

const members: MemberSummary[] = [
  {
    userId: 'user-1',
    role: OrgRole.Owner,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    joinedAt: '2026-01-05T00:00:00Z',
    source: 'conversion',
  },
  {
    userId: 'user-2',
    role: OrgRole.Admin,
    email: 'grace@example.com',
    joinedAt: '2026-02-01T00:00:00Z',
    source: 'invitation',
    invitedBy: 'user-1',
  },
  {
    userId: 'user-3',
    role: OrgRole.Member,
    joinedAt: '2026-03-01T00:00:00Z',
    source: 'invitation',
    invitedBy: 'user-1',
  },
  {
    userId: 'user-4',
    role: OrgRole.ReadOnly,
    name: 'Katherine Johnson',
    joinedAt: '2026-03-14T00:00:00Z',
    source: 'invitation',
  },
];

/** The ceiling as the caller in `actorRole` sees it — the shared predicates. */
function scopeFor(actorRole: OrgRole) {
  return {
    mayChangeRole: (from: string, to: string) => canChangeRole(actorRole, from, to),
    mayManageTarget: (target: string) => canManageTargetRole(actorRole, target),
  };
}

const meta: Meta<typeof MembersTable> = {
  title: 'Components/MembersTable',
  component: MembersTable,
  args: {
    members,
    currentUserId: 'user-1',
    onChangeRole: () => {},
    onRemove: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof MembersTable>;

/**
 * An Owner reaches every row, including their own, and is the only role that can
 * hand the seat over. The transfer is absent from their own row and from any
 * other Owner's: neither is a transfer.
 */
export const AsOwner: Story = {
  args: { ...scopeFor(OrgRole.Owner), mayTransfer: true, onTransfer: () => {} },
};

/**
 * An Admin manages Admins and below. The Owner row is a badge with no verbs on
 * it, and Owner is missing from every role picker — an Admin can neither demote
 * an Owner nor make one.
 */
export const AsAdmin: Story = {
  args: { ...scopeFor(OrgRole.Admin), currentUserId: 'user-2' },
};

/** A Member sees who is in the org and changes nothing. */
export const AsMember: Story = {
  args: { ...scopeFor(OrgRole.Member), currentUserId: 'user-3' },
};

/**
 * What the list looks like today: a user's display identity lives in Auth0, so
 * most rows carry an id and a role and nothing else.
 */
export const IdentityUnknown: Story = {
  args: {
    ...scopeFor(OrgRole.Owner),
    members: members.map(({ name: _name, email: _email, ...rest }) => rest),
  },
};

/** One person, which is every account until the first invitation is accepted. */
export const SoleOwner: Story = {
  args: { ...scopeFor(OrgRole.Owner), members: [members[0]] },
};
