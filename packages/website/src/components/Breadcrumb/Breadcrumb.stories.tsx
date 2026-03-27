import type { Meta, StoryObj } from '@storybook/react-vite';

import { Breadcrumb } from './Breadcrumb';

const meta: Meta<typeof Breadcrumb> = {
  title: 'Components/Breadcrumb',
  component: Breadcrumb,
};

export default meta;
type Story = StoryObj<typeof Breadcrumb>;

export const Default: Story = {
  args: {
    items: [
      { label: 'Buckets', href: '/buckets' },
      { label: 'my-bucket', href: '/buckets/my-bucket' },
      { label: 'photo.png' },
    ],
  },
};

export const TwoLevels: Story = {
  args: {
    items: [{ label: 'Buckets', href: '/buckets' }, { label: 'my-bucket' }],
  },
};

export const SingleItem: Story = {
  args: {
    items: [{ label: 'Dashboard' }],
  },
};
