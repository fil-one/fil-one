import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from './Card';

const meta: Meta<typeof Card> = {
  title: 'Components/Card',
  component: Card,
  argTypes: {
    shadow: { control: 'boolean' },
    padding: { control: 'select', options: ['none', 'md'] },
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: {
    children: 'Card content',
    shadow: false,
    padding: 'md',
  },
};

export const WithShadow: Story = {
  args: {
    children: 'Card content',
    shadow: true,
    padding: 'md',
  },
};

export const NoPadding: Story = {
  args: {
    shadow: true,
    padding: 'none',
    children: (
      <div className="divide-y divide-zinc-200">
        <div className="px-5 py-3 text-sm text-zinc-700">Row one</div>
        <div className="px-5 py-3 text-sm text-zinc-700">Row two</div>
        <div className="px-5 py-3 text-sm text-zinc-700">Row three</div>
      </div>
    ),
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4 p-6 bg-zinc-50 min-h-screen">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        Default (no shadow)
      </p>
      <Card>
        <p className="text-sm text-zinc-700">No shadow, default padding</p>
      </Card>

      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        With shadow
      </p>
      <Card shadow>
        <p className="text-sm text-zinc-700">With shadow, default padding</p>
      </Card>

      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        No padding + shadow
      </p>
      <Card shadow padding="none">
        <div className="divide-y divide-zinc-200">
          <div className="px-5 py-3 text-sm text-zinc-700">Row one</div>
          <div className="px-5 py-3 text-sm text-zinc-700">Row two</div>
          <div className="px-5 py-3 text-sm text-zinc-700">Row three</div>
        </div>
      </Card>
    </div>
  ),
};
