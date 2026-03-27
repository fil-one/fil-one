import type { Meta, StoryObj } from '@storybook/react-vite';
import { DownloadSimpleIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  args: {
    children: 'Button',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
    },
    size: {
      control: 'radio',
      options: ['default', 'sm', 'lg', 'icon'],
    },
    disabled: { control: 'boolean' },
    asChild: { control: false },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: { variant: 'default' },
};

export const Destructive: Story = {
  args: { variant: 'destructive' },
};

export const Outline: Story = {
  args: { variant: 'outline' },
};

export const Secondary: Story = {
  args: { variant: 'secondary' },
};

export const Ghost: Story = {
  args: { variant: 'ghost' },
};

export const Link: Story = {
  args: { variant: 'link' },
};

export const Small: Story = {
  args: { variant: 'default', size: 'sm' },
};

export const Large: Story = {
  args: { variant: 'default', size: 'lg' },
};

export const Icon: Story = {
  render: () => (
    <Button variant="default" size="icon" aria-label="Download">
      <DownloadSimpleIcon />
    </Button>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <Button variant="default">
      <DownloadSimpleIcon />
      Download
    </Button>
  ),
};

export const Disabled: Story = {
  args: { variant: 'default', disabled: true },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-3">
      <Button size="lg">Large</Button>
      <Button size="default">Default</Button>
      <Button size="sm">Small</Button>
      <Button size="icon" aria-label="Download">
        <DownloadSimpleIcon />
      </Button>
    </div>
  ),
};

export const AsChild: Story = {
  render: () => (
    <Button asChild>
      <a href="https://example.com" target="_blank" rel="noopener noreferrer">
        Open link <ArrowRightIcon />
      </a>
    </Button>
  ),
};
