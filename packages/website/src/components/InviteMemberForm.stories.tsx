import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrgRole } from '@filone/shared';

import { InviteMemberForm } from './InviteMemberForm';

const meta: Meta<typeof InviteMemberForm> = {
  title: 'Components/InviteMemberForm',
  component: InviteMemberForm,
  args: {
    roles: [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly],
    onSubmit: () => {},
    onCancel: () => {},
  },
  // The form renders `ModalBody`/`ModalFooter`, which are styled for the panel
  // they normally sit in.
  decorators: [
    (Story) => (
      <div className="modal-panel modal-panel--md">
        <Story />
      </div>
    ),
  ],
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
 * A refusal the dialog keeps rather than toasts, beside the controls that
 * caused it. The pending cap and the beta gate are not among these: both make
 * the whole dialog pointless, so the section closes it and says so on the page.
 */
export const Refused: Story = {
  args: { errorMessage: 'That address is already a member of this organization.' },
};
