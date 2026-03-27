import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProgressBar } from './ProgressBar';

const meta: Meta<typeof ProgressBar> = {
  title: 'Components/ProgressBar',
  component: ProgressBar,
  argTypes: {
    size: { control: 'select', options: ['sm', 'md'] },
    value: { control: { type: 'range', min: 0, max: 100 } },
  },
};

export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
  args: { value: 60, label: 'Progress' },
};

export const Small: Story = {
  args: { value: 40, size: 'sm', label: 'Progress' },
};

export const Empty: Story = {
  args: { value: 0, label: 'Empty' },
};

export const Full: Story = {
  args: { value: 100, label: 'Complete' },
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <ProgressBar value={0} label="0%" />
      <ProgressBar value={25} label="25%" />
      <ProgressBar value={50} label="50%" />
      <ProgressBar value={75} label="75%" />
      <ProgressBar value={100} label="100%" />
      <ProgressBar value={50} size="sm" label="Small" />
    </div>
  ),
};
