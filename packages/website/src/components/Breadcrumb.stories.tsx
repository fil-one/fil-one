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
    items: [{ label: 'Buckets' }, { label: 'my-bucket' }],
  },
};

export const ThreeLevels: Story = {
  args: {
    items: [{ label: 'Buckets' }, { label: 'my-bucket' }, { label: 'settings' }],
  },
};

export const SingleItem: Story = {
  args: {
    items: [{ label: 'Dashboard' }],
  },
};
