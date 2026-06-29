import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToggleConfirmModal } from './ToggleConfirmModal';

const meta: Meta<typeof ToggleConfirmModal> = {
  title: 'Components/ToggleConfirmModal',
  component: ToggleConfirmModal,
  args: {
    open: true,
    onClose: () => {},
    onConfirm: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ToggleConfirmModal>;

/** Enabling a bucket — shows pricing and an Enable action. */
export const Enable: Story = {
  args: { enabled: false, pending: false },
};

/** Disabling a bucket — explains what happens and offers a destructive action. */
export const Disable: Story = {
  args: { enabled: true, pending: false },
};

/** Mid-request — actions are disabled while the toggle is pending. */
export const Pending: Story = {
  args: { enabled: false, pending: true },
};
