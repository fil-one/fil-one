import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from './Card';

const meta: Meta<typeof Card> = {
  title: 'Components/Card',
  component: Card,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: {
    children: (
      <p className="text-sm text-zinc-600">
        This is a card. It provides a consistent container with border, background, and shadow.
      </p>
    ),
  },
};

export const WithHeading: Story = {
  render: () => (
    <Card>
      <h2 className="mb-3 text-sm font-medium text-zinc-900">Card title</h2>
      <p className="text-sm text-zinc-500">Card body content goes here.</p>
    </Card>
  ),
};

export const Stacked: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-zinc-600">First card</p>
      </Card>
      <Card>
        <p className="text-sm text-zinc-600">Second card</p>
      </Card>
    </div>
  ),
};
