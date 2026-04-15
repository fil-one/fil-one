import type { Meta, StoryObj } from '@storybook/react-vite';

import { PlusIcon, TrashIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: {
    variant: 'primary',
    children: 'Create bucket',
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    children: 'Cancel',
  },
};

export const Tertiary: Story = {
  args: {
    variant: 'tertiary',
    children: 'Learn more',
  },
};

export const Filled: Story = {
  args: {
    variant: 'filled',
    children: 'Upgrade',
  },
};

export const WithIcon: Story = {
  args: {
    variant: 'primary',
    icon: PlusIcon,
    children: 'New key',
  },
};

export const Compact: Story = {
  args: {
    variant: 'primary',
    size: 'compact',
    children: 'Compact',
  },
};

export const DisabledButton: Story = {
  args: {
    variant: 'primary',
    disabled: true,
    children: 'Disabled',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="tertiary">Tertiary</Button>
        <Button variant="filled">Filled</Button>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" icon={PlusIcon}>
          With icon
        </Button>
        <Button variant="ghost" icon={TrashIcon}>
          Delete
        </Button>
        <Button variant="tertiary" icon={ArrowRightIcon}>
          Continue
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" size="compact">
          Compact
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </div>
    </div>
  ),
};
