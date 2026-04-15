import type { Meta, StoryObj } from '@storybook/react-vite';

import { Spinner } from './Spinner';

const meta: Meta<typeof Spinner> = {
  title: 'Components/Spinner',
  component: Spinner,
};

export default meta;
type Story = StoryObj<typeof Spinner>;

export const Default: Story = {
  args: {
    ariaLabel: 'Loading',
  },
};

export const WithMessage: Story = {
  args: {
    message: 'Loading buckets...',
  },
};

export const Small: Story = {
  args: {
    size: 24,
    ariaLabel: 'Loading',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex items-end gap-12">
      <Spinner size={24} ariaLabel="Small" />
      <Spinner ariaLabel="Default" />
      <Spinner message="Loading buckets..." />
    </div>
  ),
};
