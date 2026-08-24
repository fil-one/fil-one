import type { Meta, StoryObj } from '@storybook/react-vite';

import { Skeleton } from './Skeleton';

const meta: Meta<typeof Skeleton> = {
  title: 'Components/Skeleton',
  component: Skeleton,
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const TextLine: Story = {
  args: {
    className: 'h-4 w-48',
  },
};

export const Shapes: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-32 rounded-lg" />
      <Skeleton className="size-10 rounded-full" />
    </div>
  ),
};

export const Card: Story = {
  render: () => (
    <div className="w-72 rounded-xl border border-zinc-200 bg-white p-5">
      <Skeleton className="mb-4 h-3 w-24" />
      <Skeleton className="mb-2 h-4 w-48" />
      <Skeleton className="h-3 w-36" />
    </div>
  ),
};
