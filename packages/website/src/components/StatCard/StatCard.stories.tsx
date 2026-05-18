import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatCard } from './StatCard';

const meta: Meta<typeof StatCard> = {
  title: 'Components/StatCard',
  component: StatCard,
};

export default meta;
type Story = StoryObj<typeof StatCard>;

export const Default: Story = {
  args: {
    label: 'Buckets',
    value: '3',
  },
};

export const WithLimit: Story = {
  args: {
    label: 'Objects',
    value: '1,240',
    limit: '/ 10,000',
  },
};

export const WithProgress: Story = {
  args: {
    label: 'Storage',
    value: '23.4 GB',
    limit: '/ 1 TB',
    progress: 23,
    size: 'lg',
  },
};

export const LargeWithUsage: Story = {
  args: {
    label: 'Downloads',
    value: '145 GB',
    limit: '/ 1 TB',
    usage: '14.5%',
    progress: 14,
    size: 'lg',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-4 max-w-xl">
      <StatCard label="Buckets" value="3" />
      <StatCard label="Objects" value="1,240" limit="/ 10,000" />
      <StatCard label="Storage" value="23.4 GB" limit="/ 1 TB" progress={23} size="lg" />
      <StatCard
        label="Downloads"
        value="145 GB"
        limit="/ 1 TB"
        usage="14.5%"
        progress={14}
        size="lg"
      />
    </div>
  ),
};
