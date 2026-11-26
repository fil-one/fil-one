import type { Meta, StoryObj } from '@storybook/react-vite';

import { AppShellSkeleton } from './AppShellSkeleton';

const meta: Meta<typeof AppShellSkeleton> = {
  title: 'Components/AppShellSkeleton',
  component: AppShellSkeleton,
  parameters: { fullBleed: true },
};

export default meta;
type Story = StoryObj<typeof AppShellSkeleton>;

/** The console frame on a cold load, before `/me` answers. */
export const Default: Story = {};
