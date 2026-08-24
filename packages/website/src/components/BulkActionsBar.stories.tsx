import type { Meta, StoryObj } from '@storybook/react-vite';

import { BulkActionsBar } from './BulkActionsBar';

const meta: Meta<typeof BulkActionsBar> = {
  title: 'Components/BulkActionsBar',
  component: BulkActionsBar,
  args: {
    count: 3,
    onClear: () => {},
    onDelete: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof BulkActionsBar>;

export const Default: Story = {};

export const SingleRow: Story = {
  args: { count: 1 },
};

export const LargeSelection: Story = {
  args: { count: 1287 },
};

/** Where "delete" is the wrong word for the destructive action. */
export const CustomLabel: Story = {
  args: { deleteLabel: 'Revoke' },
};

/** At narrow widths the count sits above the buttons rather than squeezing them. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1' } },
};
