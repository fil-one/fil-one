import type { Meta, StoryObj } from '@storybook/react-vite';

import { TableSkeleton } from './TableSkeleton';

const meta: Meta<typeof TableSkeleton> = {
  title: 'Components/TableSkeleton',
  component: TableSkeleton,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof TableSkeleton>;

// Mirrors the Buckets table.
export const Buckets: Story = {
  args: {
    'aria-label': 'Loading buckets',
    columns: [
      { label: 'Name' },
      { label: 'Region', className: 'hidden sm:table-cell' },
      { label: 'Created', className: 'hidden sm:table-cell' },
      {},
    ],
  },
};

// Mirrors the Access Keys table at its widest.
export const AccessKeys: Story = {
  args: {
    rows: 4,
    'aria-label': 'Loading access keys',
    columns: [
      { label: 'Name' },
      { label: 'Region', className: 'hidden md:table-cell' },
      { label: 'Buckets', className: 'hidden lg:table-cell' },
      { label: 'Permissions', className: 'hidden md:table-cell' },
      { label: 'Status', className: 'hidden sm:table-cell' },
      { label: 'Last Used', className: 'hidden md:table-cell' },
      {},
    ],
  },
};
