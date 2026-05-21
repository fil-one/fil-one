import type { Meta, StoryObj } from '@storybook/react-vite';

import { SlowOperationIndicator } from './SlowOperationIndicator';

const meta: Meta<typeof SlowOperationIndicator> = {
  title: 'Components/SlowOperationIndicator',
  component: SlowOperationIndicator,
};

export default meta;
type Story = StoryObj<typeof SlowOperationIndicator>;

export const NotLoading: Story = {
  args: {
    isLoading: false,
    operation: 'Creating bucket',
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
    operation: 'Creating bucket',
  },
};
