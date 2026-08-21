import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrgRole } from '@filone/shared';

import { InviteMemberForm } from './InviteMemberForm';

const meta: Meta<typeof InviteMemberForm> = {
  title: 'Components/InviteMemberForm',
  component: InviteMemberForm,
  args: {
    roles: [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly],
    onSubmit: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof InviteMemberForm>;

/** An Owner may hand out any of the four roles, their own included. */
export const AsOwner: Story = {};

/** An Admin's ceiling is Admin, so Owner is not among the options. */
export const AsAdmin: Story = {
  args: { roles: [OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly] },
};

/** The send is in flight. */
export const Sending: Story = {
  args: { submitting: true },
};

/**
 * The invitation exists and its token is live, but the mail never left. The
 * retry is another invitation, which replaces this one — there is no link to
 * hand over, because the token is in the email and nowhere else.
 */
export const CreatedButUndelivered: Story = {
  args: { undeliveredEmail: 'teammate@example.com' },
};

/**
 * The org has as many invitations outstanding as it may hold. It stays on the
 * form because the remedy — revoke one — is in the list right below.
 */
export const CapReached: Story = {
  args: {
    errorMessage:
      'This organization already has 25 pending invitations. Revoke one before sending another.',
  },
};

/**
 * The invite beta is not switched on for this org. The controls go: nothing on
 * this form would work, and the server's own sentence is what explains it.
 */
export const NotEnabled: Story = {
  args: { notEnabledMessage: 'Inviting teammates is not enabled for this organization yet.' },
};
