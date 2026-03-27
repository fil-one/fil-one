import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  args: {
    children: 'Badge',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'success', 'destructive', 'warning', 'info'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Default: Story = {
  args: { variant: 'default', children: 'Inactive' },
};

export const Success: Story = {
  args: { variant: 'success', children: 'Active' },
};

export const Destructive: Story = {
  args: { variant: 'destructive', children: 'Canceled' },
};

export const Warning: Story = {
  args: { variant: 'warning', children: 'Grace Period' },
};

export const Info: Story = {
  args: { variant: 'info', children: 'Trial' },
};

export const WithIcon: Story = {
  render: () => (
    <Badge variant="success">
      <CheckCircleIcon size={12} weight="fill" />
      Active
    </Badge>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="default">Inactive</Badge>
      <Badge variant="success">Active</Badge>
      <Badge variant="destructive">Canceled</Badge>
      <Badge variant="warning">Grace Period</Badge>
      <Badge variant="info">Trial</Badge>
    </div>
  ),
};

export const UsageExamples: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-24">Bucket</span>
        <Badge variant="success">Public</Badge>
        <Badge variant="default">Private</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-24">API Key</span>
        <Badge variant="success">Active</Badge>
        <Badge variant="default">Inactive</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-24">Billing</span>
        <Badge variant="info">Trial</Badge>
        <Badge variant="success">
          <CheckCircleIcon size={12} weight="fill" />
          Active
        </Badge>
        <Badge variant="warning">Grace Period</Badge>
        <Badge variant="destructive">Canceled</Badge>
      </div>
    </div>
  ),
};
