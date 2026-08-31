import type { Meta, StoryObj } from '@storybook/react-vite';

import { TransferOwnershipDialog } from './TransferOwnershipDialog';

const meta: Meta<typeof TransferOwnershipDialog> = {
  title: 'Components/TransferOwnershipDialog',
  component: TransferOwnershipDialog,
  args: {
    open: true,
    orgName: 'Acme',
    memberName: 'grace@example.com',
    onClose: () => {},
    onConfirm: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof TransferOwnershipDialog>;

/**
 * The confirm stays inert until the organization's name is typed. This is the
 * one console action that takes away the caller's own authority and has no undo
 * they hold themselves.
 */
export const Default: Story = {};

/** The transfer is in flight, and the dialog cannot be dismissed out from under it. */
export const Transferring: Story = {
  args: { pending: true },
};

/** A member with no name on their profile row is named by their address. */
export const LongOrgName: Story = {
  args: { orgName: 'Contoso Manufacturing International', memberName: 'user-8f21c3' },
};
