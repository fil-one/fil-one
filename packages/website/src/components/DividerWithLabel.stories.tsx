import type { Meta, StoryObj } from '@storybook/react-vite';

import { DividerWithLabel } from './DividerWithLabel';

const meta: Meta<typeof DividerWithLabel> = {
  title: 'Components/DividerWithLabel',
  component: DividerWithLabel,
};

export default meta;
type Story = StoryObj<typeof DividerWithLabel>;

export const Default: Story = {
  args: {
    label: 'or',
  },
};

export const CustomLabel: Story = {
  args: {
    label: 'continue with',
  },
};
