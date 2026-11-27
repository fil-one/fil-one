import type { Meta, StoryObj } from '@storybook/react-vite';

import { McpConnectSection } from './McpConnectSection';

const meta: Meta<typeof McpConnectSection> = {
  title: 'Pages/McpConnectSection',
  component: McpConnectSection,
};

export default meta;
type Story = StoryObj<typeof McpConnectSection>;

export const Default: Story = {};
