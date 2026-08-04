import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToggleConfirmModal } from './ToggleConfirmModal';

const meta: Meta<typeof ToggleConfirmModal> = {
  title: 'Components/ToggleConfirmModal',
  component: ToggleConfirmModal,
  args: {
    open: true,
    bucketName: 'my-docs',
    onClose: () => {},
    onConfirm: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ToggleConfirmModal>;

/** Starting indexing: names the bucket, the 6-hourly schedule, and the file types. */
export const Enable: Story = {
  args: { enabled: false, pending: false },
};

/** Stopping indexing: reassures that nothing is deleted, with a destructive action. */
export const Disable: Story = {
  args: { enabled: true, pending: false },
};

/** Mid-request — actions are disabled while the toggle is pending. */
export const Pending: Story = {
  args: { enabled: false, pending: true },
};

/** A long bucket name still has to wrap cleanly in the header description. */
export const LongBucketName: Story = {
  args: {
    enabled: false,
    pending: false,
    bucketName: 'acme-production-customer-support-transcripts-archive',
  },
};
