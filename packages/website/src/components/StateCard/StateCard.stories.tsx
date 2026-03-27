import type { Meta, StoryObj } from '@storybook/react-vite';

import { StateCard } from './StateCard';

const meta: Meta<typeof StateCard> = {
  title: 'Components/StateCard',
  component: StateCard,
};

export default meta;
type Story = StoryObj<typeof StateCard>;

export const Dashed: Story = {
  args: {
    border: 'dashed',
    children: 'Empty state content goes here',
  },
};

export const Solid: Story = {
  args: {
    border: 'solid',
    children: 'Solid border card content',
  },
};

export const SubtleBackground: Story = {
  args: {
    border: 'solid',
    background: 'subtle',
    children: 'Card with subtle background',
  },
};
