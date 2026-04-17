import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tooltip } from './Tooltip';

const meta: Meta<typeof Tooltip> = {
  title: 'Components/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
  argTypes: {
    side: { control: 'select', options: ['right', 'left', 'top', 'bottom'] },
  },
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const Default: Story = {
  args: {
    content: 'Tooltip content',
    side: 'right',
    children: (
      <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700">
        Hover me
      </button>
    ),
  },
};

export const AllSides: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-12 p-8">
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <div key={side} className="flex items-center justify-center">
          <Tooltip content={`Tooltip (${side})`} side={side}>
            <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 capitalize">
              {side}
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  ),
};
