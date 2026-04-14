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
    children: 'Dashed border card',
  },
};

export const Solid: Story = {
  args: {
    border: 'solid',
    children: 'Solid border card',
  },
};

export const SubtleBackground: Story = {
  args: {
    border: 'solid',
    background: 'subtle',
    children: 'Solid border with subtle background',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4 max-w-md">
      <StateCard border="dashed">Dashed border</StateCard>
      <StateCard border="solid">Solid border</StateCard>
      <StateCard border="solid" background="subtle">
        Solid border with subtle background
      </StateCard>
    </div>
  ),
};
