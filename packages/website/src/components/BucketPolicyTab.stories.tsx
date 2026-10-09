import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region } from '@filone/shared';

import { BucketPolicyTab } from './BucketPolicyTab';

const meta: Meta<typeof BucketPolicyTab> = {
  title: 'Components/BucketPolicyTab',
  component: BucketPolicyTab,
  args: { bucketName: 'photos', region: S3Region.UsEast9 },
};

export default meta;
type Story = StoryObj<typeof BucketPolicyTab>;

export const Default: Story = {};
