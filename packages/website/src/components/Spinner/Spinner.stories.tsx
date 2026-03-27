import type { Meta, StoryObj } from '@storybook/react-vite';

import { Spinner } from './Spinner';

const meta: Meta<typeof Spinner> = {
  title: 'Components/Spinner',
  component: Spinner,
};

export default meta;
type Story = StoryObj<typeof Spinner>;

export const Default: Story = {
  args: { ariaLabel: 'Loading' },
};

export const Small: Story = {
  args: { ariaLabel: 'Loading', size: 16 },
};

export const WithMessage: Story = {
  args: { message: 'Loading data...' },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-8">
      <Spinner ariaLabel="Loading" size={10} />
      <Spinner ariaLabel="Loading" size={16} />
      <Spinner ariaLabel="Loading" size={24} />
      <Spinner ariaLabel="Loading" size={32} />
      <Spinner ariaLabel="Loading" size={52} />
    </div>
  ),
};
