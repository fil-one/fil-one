import type { Meta, StoryObj } from '@storybook/react-vite';

import { CopyButton } from './CopyButton';

const meta: Meta<typeof CopyButton> = {
  title: 'Components/CopyButton',
  component: CopyButton,
};

export default meta;
type Story = StoryObj<typeof CopyButton>;

export const Default: Story = {
  args: {
    value: 'AKIAxyz1234567890',
    size: 'sm',
  },
};

export const Medium: Story = {
  args: {
    value: 'AKIAxyz1234567890',
    size: 'md',
  },
};

export const InContext: Story = {
  render: () => (
    <div className="flex items-center gap-1">
      <span className="font-mono text-xs text-zinc-500">AKIAxyz1234567890</span>
      <CopyButton value="AKIAxyz1234567890" size="sm" />
    </div>
  ),
};
