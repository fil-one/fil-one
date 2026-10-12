import type { Meta, StoryObj } from '@storybook/react-vite';

import { DeleteBucketDialog } from './DeleteBucketDialog';

const meta: Meta<typeof DeleteBucketDialog> = {
  title: 'Components/DeleteBucketDialog',
  component: DeleteBucketDialog,
  args: {
    bucketName: 'my-bucket',
    onClose: () => {},
    onConfirm: () => new Promise<void>(() => {}),
    onOpenBucket: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof DeleteBucketDialog>;

/** While S3 is asked what the bucket holds: Delete waits for the answer. */
export const Checking: Story = { args: { contents: 'checking' } };

/** An empty bucket: the confirmation. Clicking Delete bucket holds it in its loading state. */
export const Empty: Story = { args: { contents: 'empty' } };

/** A bucket with objects left: no Delete, a way to the bucket page instead. */
export const NotEmpty: Story = { args: { contents: 'not-empty' } };
