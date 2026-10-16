import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConnectionDetailsTab } from './ConnectionDetailsTab';

const meta: Meta<typeof ConnectionDetailsTab> = {
  title: 'Pages/ConnectionDetailsTab',
  component: ConnectionDetailsTab,
};

export default meta;
type Story = StoryObj<typeof ConnectionDetailsTab>;

export const Default: Story = {};
