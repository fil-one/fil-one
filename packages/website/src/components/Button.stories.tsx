import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  args: {
    children: 'Button',
    variant: 'default',
    size: 'default',
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: {
    variant: 'default',
    children: 'Create bucket',
  },
};

export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Delete bucket',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Cancel',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Save changes',
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    children: 'Settings',
  },
};

export const Link: Story = {
  args: {
    variant: 'link',
    children: 'Learn more',
  },
};

export const Small: Story = {
  args: {
    variant: 'default',
    size: 'sm',
    children: 'Create bucket',
  },
};

export const Large: Story = {
  args: {
    variant: 'default',
    size: 'lg',
    children: 'Get started',
  },
};

export const Icon: Story = {
  args: {
    variant: 'outline',
    size: 'icon',
    children: '⚙',
  },
};

export const Disabled: Story = {
  args: {
    variant: 'default',
    children: 'Unavailable',
    disabled: true,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};
